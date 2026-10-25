"""
商户后台 API — 登录 / Dashboard / 用户管理 / 商品管理 / 插件
"""
from fastapi import APIRouter, Depends, HTTPException, Request, File, UploadFile, Form, Query
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, delete, or_
from pydantic import BaseModel
import json
import uuid as uuid_lib
import os
import imghdr
import sys
import asyncio
from typing import Optional
from pathlib import Path
from datetime import datetime, timedelta, timezone

from app.core.database import get_db
from app.core.config import get_settings
from app.core.security import verify_password, create_access_token, decode_access_token
from app.models.all import (
    User,
    Tenant,
    TenantUser,
    TenantUserProfile,
    Product,
    MallOrder,
    MallCouponTemplate,
    MallUserCoupon,
    CarWashStore,
    CarWashOrder,
    CarWashCouponTemplate,
)
from app.services import oss_service
from app.services.image_optimizer import optimize_upload_image
from app.services.product_specs import normalize_specs
from app.services.wechat_miniapp import (
    WechatMiniProgramError,
    generate_miniapp_code,
    generate_miniapp_url_link,
)

router = APIRouter(prefix="/api/tenant", tags=["tenant"])


# ── 辅助函数 ──

def _normalize_product_images(raw) -> list[str]:
    """商品多图：去空、去重、限制 9 张。"""
    if not isinstance(raw, (list, tuple)):
        return []
    result: list[str] = []
    for item in raw:
        url = str(item or "").strip()
        if url and url not in result:
            result.append(url)
        if len(result) >= 9:
            break
    return result


def _public_image_url(url: str) -> str:
    """把 OSS 直链换成 xhscdn.cn 反代地址，满足小程序 downloadFile 白名单。"""
    value = str(url or "").strip()
    if not value:
        return ""
    settings = get_settings()
    oss_prefix = f"https://{settings.oss_bucket}.{settings.oss_endpoint}/"
    if value.startswith(oss_prefix):
        return "https://xhscdn.cn/oss/" + value[len(oss_prefix):]
    return value


def _product_image_fields(p):
    """兼容旧数据：没有图集时退回单图封面。"""
    images = [_public_image_url(url) for url in _normalize_product_images(getattr(p, "images", None))]
    cover = _public_image_url(getattr(p, "image_url", ""))
    if not images and cover:
        images = [cover]
    if not cover and images:
        cover = images[0]
    return cover, images


def _extract_tenant_id(request: Request) -> str:
    """从请求中提取 tenant_id"""
    token = request.headers.get("Authorization", "").replace("Bearer ", "") or request.cookies.get("tenant_token")
    if not token:
        raise HTTPException(status_code=401, detail="未登录")
    payload = decode_access_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="无效的令牌")
    return payload.get("tenant_id") or payload.get("id") or ""


async def _get_tenant_oss_base(db: AsyncSession, tenant_id: str) -> str:
    """获取商户自定义 OSS 根目录"""
    base, _ = await _get_tenant_oss_config(db, tenant_id)
    return base


async def _get_tenant_oss_config(db: AsyncSession, tenant_id: str) -> tuple[str, str]:
    """获取商户 OSS 配置：(oss_base_dir, oss_fixed_filename)

    - oss_base_dir: 优先 kuaishou_oss_path → oss_base_path → 全局默认
    - oss_fixed_filename: kuaishou_oss_filename，空字符串表示不固定
    """
    from uuid import UUID
    row = await db.execute(select(Tenant).where(Tenant.id == UUID(tenant_id)))
    t = row.scalar_one_or_none()
    fixed_name = ""
    if t and t.settings:
        s = json.loads(t.settings) if isinstance(t.settings, str) else t.settings
        custom = (s.get("kuaishou_oss_path", "") or s.get("oss_base_path", "")).strip()
        fixed_name = s.get("kuaishou_oss_filename", "").strip()
        if custom:
            return custom.rstrip("/"), fixed_name
    from app.core.config import get_settings
    return get_settings().oss_base_path.rstrip("/"), fixed_name


def _detect_image_type(content: bytes, filename: str = "") -> str:
    """检测图片类型，兼容无后缀 / 非标准后缀的文件。

    优先级：文件头魔数 > imghdr > 扩展名推测 > png 兜底
    """
    import imghdr

    # 1. 文件头魔数检测（最可靠，无视扩展名）
    if content[:4] == b"\x89PNG":
        return "png"
    if content[:2] == b"\xff\xd8":
        return "jpeg"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if content[:4] in (b"RIFF") and content[8:12] == b"WEBP":
        return "webp"
    if content[:2] in (b"BM",):
        return "bmp"
    if content[:4] == b"<?xml" or content[:5] == b"<svg ":
        return "svg+xml"

    # 2. imghdr 回退
    detected = imghdr.what(None, content)
    if detected:
        return detected

    # 3. 从文件名扩展名推测
    if filename:
        ext = os.path.splitext(filename)[1].lower().lstrip(".")
        ext_map = {
            "jpg": "jpeg", "jpeg": "jpeg", "png": "png",
            "gif": "gif", "webp": "webp", "bmp": "bmp",
            "svg": "svg+xml", "ico": "x-icon",
        }
        if ext in ext_map:
            return ext_map[ext]

    # 4. 兜底
    return "png"


def _sanitize_filename(name: str) -> str:
    """清理文件名：去路径、保留中文/字母/数字/下划线/点/连字符"""
    import re
    # 先取最后一段（去掉路径）
    name = name.replace("\\", "/").split("/")[-1]
    # 去掉不安全字符，保留中文、字母、数字、下划线、点、连字符
    name = re.sub(r"[^\w\u4e00-\u9fff.\-]", "_", name, flags=re.UNICODE)
    # 去掉连续下划线
    name = re.sub(r"_{2,}", "_", name)
    # 去掉首尾下划线和点
    name = name.strip("_.")
    return name or "image"


async def _optimize_upload_or_400(
    content: bytes,
    *,
    profile: str,
    max_dimension: int,
):
    """Run the CPU-heavy image optimizer off the event loop with a clean 400."""
    try:
        return await asyncio.to_thread(
            optimize_upload_image,
            content,
            profile=profile,
            max_dimension=max_dimension,
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(
            status_code=400,
            detail="图片无法压缩至 30KB 以内，请换一张内容更简单的图片",
        ) from exc


# ── 登录 ──

class TenantLoginRequest(BaseModel):
    username: str
    password: str

class TenantLoginResponse(BaseModel):
    success: bool
    token: Optional[str] = None
    message: Optional[str] = None


@router.post("/login")
async def tenant_login(
    data: TenantLoginRequest, request: Request, db: AsyncSession = Depends(get_db)
):
    """商户登录（验证 tenant 内用户）

    支持三种方式识别商户：
    1. X-Tenant-Id 请求头
    2. tenant_id 查询参数
    3. 自动根据用户名查找所属商户（仅当该用户只属于一个商户时）
    """
    # 优先从请求头/查询参数获取 tenant_id
    tenant_id = request.headers.get("X-Tenant-Id") or request.query_params.get("tenant_id")
    from uuid import UUID
    from app.models.all import User

    if not tenant_id:
        # 自动查找：该用户名所属的商户
        result = await db.execute(
            select(TenantUser, User).join(User, TenantUser.user_id == User.id).where(
                User.username == data.username,
                User.is_active == True,
            )
        )
        rows = result.all()
        if not rows:
            return {"success": False, "message": "用户名或密码错误"}
        if len(rows) > 1:
            return {"success": False, "message": "该账号属于多个商户，请通过子域名或 X-Tenant-Id 登录"}
        tu, u = rows[0]
        tenant_id = str(tu.tenant_id)
        tid = UUID(tenant_id)
    else:
        tid = UUID(tenant_id)
        # 查找该商户下的用户
        result = await db.execute(
            select(TenantUser, User).join(User, TenantUser.user_id == User.id).where(
                TenantUser.tenant_id == tid,
                User.username == data.username,
                User.is_active == True,
            )
        )
        row = result.one_or_none()
        if not row:
            return {"success": False, "message": "用户名或密码错误"}
        tu, u = row

    if not verify_password(data.password, u.password_hash):
        return {"success": False, "message": "用户名或密码错误"}

    # 添加商户名称到 JWT，前端可显示当前登录商户
    tenant_row = await db.execute(select(Tenant).where(Tenant.id == tid))
    tenant = tenant_row.scalar_one_or_none()
    tenant_name = tenant.name if tenant else ""

    token = create_access_token(
        data={
            "sub": str(u.id),
            "tenant_id": tenant_id,
            "tenant_name": tenant_name,
            "tenant_user_id": str(tu.id),
            "role": tu.role_in_tenant,
            "username": u.username,
        },
        expires_delta=timedelta(seconds=3600 * 24 * 7),
    )

    return TenantLoginResponse(
        success=True,
        token=token,
        message="登录成功",
    )


# ── Dashboard 统计 ──

@router.get("/dashboard")
async def tenant_dashboard_stats(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户 Dashboard 概览数据"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from datetime import datetime, timezone, timedelta
    tid = UUID(tenant_id_str)

    # 用户数
    user_count = (
        await db.execute(
            select(func.count(TenantUser.id)).where(TenantUser.tenant_id == tid)
        )
    ).scalar()

    # 商品数
    product_count = (
        await db.execute(
            select(func.count(Product.id)).where(Product.tenant_id == tid)
        )
    ).scalar()

    # 门店数
    store_count = (
        await db.execute(
            select(func.count(CarWashStore.id)).where(
                CarWashStore.tenant_id == tid,
                CarWashStore.is_active == True,
            )
        )
    ).scalar()

    # 今日订单数
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_orders = (
        await db.execute(
            select(func.count(CarWashOrder.id)).where(
                CarWashOrder.tenant_id == tid,
                CarWashOrder.created_at >= today_start,
            )
        )
    ).scalar()

    # 总订单数
    total_orders = (
        await db.execute(
            select(func.count(CarWashOrder.id)).where(CarWashOrder.tenant_id == tid)
        )
    ).scalar()

    # 本月营收（已支付）
    month_start = today_start.replace(day=1)
    monthly_revenue = (
        await db.execute(
            select(func.coalesce(func.sum(CarWashOrder.final_amount), 0)).where(
                CarWashOrder.tenant_id == tid,
                CarWashOrder.payment_status == "paid",
                CarWashOrder.created_at >= month_start,
            )
        )
    ).scalar()

    # 总营收（已支付）
    total_revenue = (
        await db.execute(
            select(func.coalesce(func.sum(CarWashOrder.final_amount), 0)).where(
                CarWashOrder.tenant_id == tid,
                CarWashOrder.payment_status == "paid",
            )
        )
    ).scalar()

    # 活跃优惠券模板
    active_coupons = (
        await db.execute(
            select(func.count(CarWashCouponTemplate.id)).where(
                CarWashCouponTemplate.tenant_id == tid,
                CarWashCouponTemplate.is_active == True,
            )
        )
    ).scalar()

    return {
        "total_users": user_count or 0,
        "total_products": product_count or 0,
        "today_orders": today_orders or 0,
        "total_orders": total_orders or 0,
        "monthly_revenue": float(monthly_revenue or 0),
        "total_revenue": float(total_revenue or 0),
        "active_coupons": active_coupons or 0,
        "total_stores": store_count or 0,
        "tenant_id": tenant_id_str,
    }


# ── 插件列表 ──

@router.get("/plugins")
async def get_tenant_plugins(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """返回当前商户启用的插件列表（用于控制菜单/权限）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    row = await db.execute(select(Tenant).where(Tenant.id == UUID(tenant_id_str)))
    t = row.scalar_one_or_none()
    if not t:
        return {"plugins": []}
    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})
    # 插件权限完全由总后台为租户配置；未勾选的租户不可见、不可用。
    return {"plugins": settings.get("plugins", [])}


# ── 导航配置 ──

@router.get("/nav-config")
async def get_tenant_nav_config(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取商户自定义导航配置"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    row = await db.execute(select(Tenant).where(Tenant.id == UUID(tenant_id_str)))
    t = row.scalar_one_or_none()
    if not t:
        return {"nav_items": []}
    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})
    # 优先读 nav_items（管理后台保存的字段名），向下兼容旧版 nav_config
    items = settings.get("nav_items") or settings.get("nav_config") or []
    return {"nav_items": items if isinstance(items, list) else []}


@router.get("/brand-settings")
async def get_tenant_brand_settings(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取商户品牌配置（logo_url, brand_name）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    row = await db.execute(select(Tenant).where(Tenant.id == UUID(tenant_id_str)))
    t = row.scalar_one_or_none()
    if not t:
        return {"logo_url": "", "brand_name": ""}
    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})
    return {
        "logo_url": settings.get("logo_url", "") or "",
        "brand_name": settings.get("brand_name", "") or "",
    }


# ── 商户用户管理 ──

class UserProfileCreate(BaseModel):
    username: str
    password: str
    display_name: str = ""

class UserProfileUpdate(BaseModel):
    display_name: Optional[str] = None
    is_active: Optional[bool] = None
    password: Optional[str] = None


@router.get("/users")
async def list_tenant_users(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取当前商户下的所有用户（含系统用户信息）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(TenantUser, User)
        .join(User, TenantUser.user_id == User.id)
        .where(TenantUser.tenant_id == tid)
        .order_by(TenantUser.created_at.desc())
    )
    rows = result.all()

    return [
        {
            "id": tu.id.hex,
            "username": u.username,
            "display_name": u.username or "",
            "email": u.email or "",
            "is_active": u.is_active,
            "role_in_tenant": tu.role_in_tenant or "admin",
            "last_login": None,
            "created_at": tu.created_at.isoformat() if tu.created_at else None,
        }
        for tu, u in rows
    ]


@router.post("/users")
async def create_tenant_user(
    data: UserProfileCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """在商户下创建新用户"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID, uuid4

    # 检查用户名是否已存在
    existing = await db.execute(
        select(TenantUser).where(
            TenantUser.tenant_id == UUID(tenant_id_str),
            TenantUser.username == data.username,
        )
    )
    if existing.scalar_one_or_none():
        return {"success": False, "message": "用户名已存在"}

    from app.core.security import get_password_hash
    user = TenantUser(
        id=uuid4(),
        tenant_id=UUID(tenant_id_str),
        username=data.username,
        display_name=data.display_name or data.username,
        hashed_password=get_password_hash(data.password),
    )

    db.add(user)
    await db.commit()

    return {"success": True, "id": user.id.hex, "message": "用户创建成功"}


@router.put("/users/{user_id}")
async def update_tenant_user(
    user_id: str,
    data: UserProfileUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """更新商户用户信息"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID

    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(TenantUser).where(TenantUser.id == UUID(user_id), TenantUser.tenant_id == tid)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if data.display_name is not None:
        user.display_name = data.display_name
    if data.is_active is not None:
        user.is_active = data.is_active
    if data.password:
        from app.core.security import get_password_hash
        user.hashed_password = get_password_hash(data.password)

    db.add(user)
    await db.commit()
    return {"success": True, "message": "用户更新成功"}


@router.delete("/users/{user_id}")
async def delete_tenant_user(
    user_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除商户用户"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID

    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(TenantUser).where(TenantUser.id == UUID(user_id), TenantUser.tenant_id == tid)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    await db.delete(user)
    await db.commit()
    return {"success": True, "message": "用户已删除"}


# ═══════════════════════════════════════
# 洗车后台 — 用户 / 订单 / 门店
# ═══════════════════════════════════════


@router.get("/users/{user_id}")
async def get_tenant_user(
    user_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取单个商户用户"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID

    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(TenantUser).where(TenantUser.id == UUID(user_id), TenantUser.tenant_id == tid)
    )
    u = result.scalar_one_or_none()
    if not u:
        raise HTTPException(status_code=404, detail="用户不存在")

    return {
        "id": u.id.hex,
        "username": u.username,
        "display_name": u.display_name or "",
        "is_active": u.is_active,
        "last_login": u.last_login.isoformat() if u.last_login else None,
        "created_at": u.created_at.isoformat() if u.created_at else None,
    }


@router.get("/miniapp-users")
async def list_miniapp_users(
    request: Request,
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
    search: str = Query("", max_length=100),
):
    """获取微信小程序用户列表（分页+搜索）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import TenantUserProfile as _TUP

    tid = UUID(tenant_id_str)

    conditions = [_TUP.tenant_id == tid]
    if search:
        like_pat = f"%{search}%"
        conditions.append(
            or_(
                _TUP.nickname.ilike(like_pat),
                _TUP.phone.ilike(like_pat),
                _TUP.openid.ilike(like_pat),
            )
        )

    count_result = await db.execute(select(func.count()).where(*conditions))
    total = count_result.scalar() or 0

    offset_val = (page - 1) * page_size
    result = await db.execute(
        select(_TUP)
        .where(*conditions)
        .order_by(_TUP.created_at.desc())
        .offset(offset_val)
        .limit(page_size)
    )
    profiles = result.scalars().all()

    items = [
        {
            "id": p.id.hex,
            "openid": p.openid,
            "nickname": p.nickname or "",
            "avatar_url": p.avatar_url or "",
            "phone": p.phone or "",
            "license_plate": p.license_plate or "",
            "address": p.address or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in profiles
    ]

    return {"items": items, "total": total}


@router.get("/miniapp-users/{profile_id}")
async def get_miniapp_user(
    profile_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import TenantUserProfile as _TUP
    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(_TUP).where(_TUP.id == UUID(profile_id), _TUP.tenant_id == tid)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")
    return {
        "id": profile.id.hex,
        "openid": profile.openid,
        "nickname": profile.nickname or "",
        "avatar_url": profile.avatar_url or "",
        "phone": profile.phone or "",
        "license_plate": profile.license_plate or "",
        "address": profile.address or "",
        "created_at": profile.created_at.isoformat() if profile.created_at else None,
    }


class MiniappUserUpdate(BaseModel):
    nickname: Optional[str] = None
    avatar_url: Optional[str] = None
    phone: Optional[str] = None
    license_plate: Optional[str] = None
    address: Optional[str] = None


@router.put("/miniapp-users/{profile_id}")
async def update_miniapp_user(
    profile_id: str,
    data: MiniappUserUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """更新微信小程序用户信息"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import TenantUserProfile as _TUP

    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(_TUP).where(_TUP.id == UUID(profile_id), _TUP.tenant_id == tid)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")

    update_fields = {}
    if data.nickname is not None:
        profile.nickname = data.nickname
        update_fields["nickname"] = data.nickname
    if data.avatar_url is not None:
        profile.avatar_url = data.avatar_url
        update_fields["avatar_url"] = data.avatar_url
    if data.phone is not None:
        profile.phone = data.phone
        update_fields["phone"] = data.phone
    if data.license_plate is not None:
        profile.license_plate = data.license_plate
        update_fields["license_plate"] = data.license_plate
    if data.address is not None:
        profile.address = data.address
        update_fields["address"] = data.address

    await db.commit()
    return {"success": True, "message": "用户已更新", "updated": update_fields}


@router.delete("/miniapp-users/{profile_id}")
async def delete_miniapp_user(
    profile_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除微信小程序用户"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import TenantUserProfile as _TUP

    tid = UUID(tenant_id_str)
    result = await db.execute(
        select(_TUP).where(_TUP.id == UUID(profile_id), _TUP.tenant_id == tid)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="用户不存在")

    await db.delete(profile)
    await db.commit()
    return {"success": True, "message": "用户已删除"}


@router.get("/orders")
async def list_car_wash_orders(
    request: Request,
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
    search: str = Query("", max_length=100),
    status: Optional[str] = Query(None, max_length=50),
):
    """获取洗车订单列表（分页+搜索+筛选）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import CarWashOrder as _CWO, TenantUserProfile as _TUP

    tid = UUID(tenant_id_str)

    # Base conditions
    conditions = [_CWO.tenant_id == tid]
    if status:
        conditions.append(_CWO.status == status)

    # Build base query with join
    base_query = (
        select(_CWO)
        .join(_TUP, _CWO.profile_id == _TUP.id, isouter=True)
        .where(*conditions)
    )

    # Search by order_no or phone
    if search:
        like_pat = f"%{search}%"
        base_query = base_query.where(
            or_(_CWO.out_trade_no.ilike(like_pat), _TUP.phone.ilike(like_pat))
        )

    # Count
    count_query = select(func.count()).select_from(_CWO).join(_TUP, _CWO.profile_id == _TUP.id, isouter=True).where(*conditions)
    if search:
        like_pat = f"%{search}%"
        count_query = count_query.where(
            or_(_CWO.out_trade_no.ilike(like_pat), _TUP.phone.ilike(like_pat))
        )
    count_result = await db.execute(count_query)
    total = count_result.scalar() or 0

    offset_val = (page - 1) * page_size
    result = await db.execute(
        base_query.order_by(_CWO.created_at.desc()).offset(offset_val).limit(page_size)
    )
    orders = result.scalars().all()

    items = []
    for o in orders:
        # Fetch profile for each order to get user info
        profile_result = await db.execute(
            select(_TUP).where(_TUP.id == o.profile_id)
        )
        prof = profile_result.scalar_one_or_none()

        items.append(
            {
                "id": o.id.hex,
                "order_no": o.out_trade_no or "",
                "user": {
                    "openid": prof.openid if prof else "",
                    "nickname": prof.nickname or prof.phone or (prof.openid[:8] + '...' if prof and prof.openid else '微信用户'),
                    "phone": prof.phone if prof else "",
                    "avatar_url": prof.avatar_url if prof else "",
                },
                "product": o.product_name or "",
                "plate_number": o.plate_number or "",
                "service_date": o.service_date or "",
                "service_time": o.service_time or "",
                "service_address": o.service_address or "",
                "total_amount": o.total_amount or 0,
                "discount_amount": o.discount_amount or 0,
                "final_amount": o.final_amount or 0,
                "status": o.status or "",
                "payment_status": o.payment_status or "",
                "short_code": o.short_code or "",
                "contact_name": o.contact_name or "",
                "contact_phone": o.contact_phone or "",
                "group_buy_activity_id": o.group_buy_activity_id or "",
                "group_buy_status": o.group_buy_status or "",
                "created_at": o.created_at.isoformat() if o.created_at else None,
                "paid_at": o.paid_at.isoformat() if o.paid_at else None,
                "completed_at": o.completed_at.isoformat() if o.completed_at else None,
            }
        )

    return {"items": items, "total": total}


@router.post("/orders/{order_id}/verify")
async def admin_verify_order(
    request: Request,
    order_id: str,
    db: AsyncSession = Depends(get_db),
):
    """管理员后台核销订单（效果等同小程序扫码核销，无需核销员身份）"""
    from uuid import UUID
    from datetime import datetime, timezone
    from app.models.all import CarWashOrder as _CWO

    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    # 查找订单
    result = await db.execute(
        select(_CWO).where(_CWO.id == UUID(order_id), _CWO.tenant_id == tid)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")

    if order.status in ("completed", "cancelled", "refunded"):
        raise HTTPException(status_code=400, detail="订单状态不允许核销")

    if order.payment_status != "paid":
        raise HTTPException(status_code=400, detail="订单未支付")

    order.status = "completed"
    order.completed_at = datetime.now(timezone.utc)
    await db.commit()

    return {"success": True, "message": "核销成功", "order_id": order_id}


@router.post("/group-buy/{activity_id}/force-complete")
async def force_complete_group_buy(
    request: Request,
    activity_id: str,
    db: AsyncSession = Depends(get_db),
):
    """管理员手动成团：将该团购活动下所有已支付订单标记为已成团"""
    from uuid import UUID
    from app.models.all import CarWashGroupBuyActivity as _GBA, CarWashOrder as _CWO

    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    # 验证活动存在且属于该商户
    act_result = await db.execute(
        select(_GBA).where(_GBA.id == UUID(activity_id), _GBA.tenant_id == tid)
    )
    activity = act_result.scalar_one_or_none()
    if not activity:
        raise HTTPException(status_code=404, detail="团购活动不存在")

    # 将该活动下所有已支付未成团的订单标记为已成团
    result = await db.execute(
        select(_CWO).where(
            _CWO.tenant_id == tid,
            _CWO.group_buy_activity_id == activity_id,
            _CWO.payment_status == "paid",
            _CWO.status.notin_(["cancelled", "canceled", "refunded"]),
            _CWO.group_buy_status != "grouped",
        )
    )
    orders = result.scalars().all()

    updated = 0
    for order in orders:
        order.group_buy_status = "grouped"
        updated += 1

    # 同步更新 sold_quantity
    if updated > 0:
        paid_count_result = await db.execute(
            select(func.coalesce(func.sum(_CWO.quantity), 0)).where(
                _CWO.tenant_id == tid,
                _CWO.group_buy_activity_id == activity_id,
                _CWO.payment_status == "paid",
                _CWO.status.notin_(["cancelled", "canceled", "refunded"]),
            )
        )
        activity.sold_quantity = paid_count_result.scalar() or 0
        db.add(activity)

    await db.commit()

    return {"success": True, "message": f"手动成团成功，{updated} 笔订单已更新", "updated": updated}


@router.get("/activities")
async def list_recent_activities(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取最近活动（Dashboard 用，最近10条订单）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import CarWashOrder as _CWO, TenantUserProfile as _TUP

    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_CWO)
        .where(_CWO.tenant_id == tid)
        .order_by(_CWO.created_at.desc())
        .limit(10)
    )
    orders = result.scalars().all()

    items = []
    for o in orders:
        profile_result = await db.execute(
            select(_TUP).where(_TUP.id == o.profile_id)
        )
        prof = profile_result.scalar_one_or_none()
        nickname = prof.nickname if prof else "用户"

        # Determine activity type based on order status
        if o.status == "completed":
            act_type = "complete"
            message = f"{nickname} 已完成洗车服务"
        elif o.payment_status == "paid":
            act_type = "payment"
            message = f"{nickname} 已支付订单"
        else:
            act_type = "new_order"
            message = f"{nickname} 提交了新订单"

        items.append(
            {
                "type": act_type,
                "message": message,
                "time": o.created_at.isoformat() if o.created_at else None,
                "user_nickname": nickname,
                "amount": o.final_amount or 0,
            }
        )

    return {"items": items}


@router.get("/stores")
async def list_car_wash_stores(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取商户门店列表"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from app.models.all import CarWashStore as _CWS

    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_CWS).where(_CWS.tenant_id == tid).order_by(_CWS.sort_order.asc(), _CWS.created_at.desc())
    )
    stores = result.scalars().all()

    return [
        {
            "id": s.id.hex,
            "name": s.name or "",
            "address": s.address or "",
            "phone": s.phone or "",
            "latitude": s.lat or 0.0,
            "longitude": s.lng or 0.0,
            "business_hours": s.business_hours or "",
            "is_active": s.is_active,
            "image_url": s.image_url or "",
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in stores
    ]


# ── 商品管理 ──

class ProductCreate(BaseModel):
    name: str
    original_price: float = 0.0
    special_price: float = 0.0
    package_details: str = ""
    sales_count: int = 0
    is_active: bool = True
    image_url: str = ""
    images: list[str] = []
    specs: list[dict] = []
    vehicle_type: str = ""
    vehicle_types: list[str] = []
    sort_order: int = 0

class ProductUpdate(BaseModel):
    name: Optional[str] = None
    original_price: Optional[float] = None
    special_price: Optional[float] = None
    package_details: Optional[str] = None
    sales_count: Optional[int] = None
    is_active: Optional[bool] = None
    image_url: Optional[str] = None
    images: Optional[list[str]] = None
    specs: Optional[list[dict]] = None
    vehicle_type: Optional[str] = None
    vehicle_types: Optional[list[str]] = None
    sort_order: Optional[int] = None


@router.get("/products")
async def list_products(
    request: Request,
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
    search: str = Query("", max_length=100),
):
    """获取商户商品列表（分页+搜索）"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # 查询条件
    conditions = [Product.tenant_id == tid]
    if search:
        conditions.append(Product.name.ilike(f"%{search}%"))

    # 总数
    count_result = await db.execute(select(func.count()).where(*conditions))
    total = count_result.scalar() or 0

    # 分页数据
    offset_val = (page - 1) * page_size
    result = await db.execute(
        select(Product)
        .where(*conditions)
        .order_by(Product.sort_order.asc(), Product.created_at.desc())
        .offset(offset_val)
        .limit(page_size)
    )
    products = result.scalars().all()

    items = []
    for p in products:
        cover, images = _product_image_fields(p)
        items.append({
            "id": p.id.hex,
            "name": p.name,
            "original_price": p.original_price or 0,
            "special_price": p.special_price or 0,
            "package_details": p.package_details or "",
            "image_url": cover,
            "images": images,
            "specs": normalize_specs(getattr(p, "specs", None)),
            "vehicle_type": p.vehicle_type or "",
            "vehicle_types": p.vehicle_types or [],
            "sales_count": p.sales_count or 0,
            "is_active": p.is_active if p.is_active is not None else True,
            "sort_order": p.sort_order or 0,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "updated_at": p.updated_at.isoformat() if p.updated_at else None,
        })

    return {"total": total, "items": items, "page": page, "page_size": page_size}


@router.get("/products/{product_id}")
async def get_product_detail(
    product_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取单个商品详情"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(Product).where(Product.id == UUID(product_id), Product.tenant_id == tid)
    )
    p = result.scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="商品不存在")

    cover, images = _product_image_fields(p)
    return {
        "id": p.id.hex,
        "name": p.name,
        "original_price": p.original_price or 0,
        "special_price": p.special_price or 0,
        "package_details": p.package_details or "",
        "image_url": cover,
        "images": images,
        "specs": normalize_specs(getattr(p, "specs", None)),
        "sales_count": p.sales_count or 0,
        "is_active": p.is_active if p.is_active is not None else True,
        "sort_order": p.sort_order or 0,
        "vehicle_type": p.vehicle_type or "",
        "vehicle_types": p.vehicle_types or [],
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


@router.get("/products/{product_id}/qrcode")
async def get_product_miniapp_qrcode(
    product_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """生成套餐独立详情页的小程序码。"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID

    tid = UUID(tenant_id_str)
    try:
        product_uuid = UUID(product_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="商品参数无效")

    result = await db.execute(
        select(Product).where(
            Product.id == product_uuid,
            Product.tenant_id == tid,
        )
    )
    product = result.scalar_one_or_none()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")
    if not product.is_active:
        raise HTTPException(status_code=400, detail="套餐已下架，请先上架后再生成推广码")

    from app.models.all import TenantMiniappConfig

    config_result = await db.execute(
        select(TenantMiniappConfig).where(TenantMiniappConfig.tenant_id == tid)
    )
    miniapp_config = config_result.scalar_one_or_none()
    if (
        not miniapp_config
        or not miniapp_config.miniapp_appid
        or not miniapp_config.miniapp_appsecret
    ):
        raise HTTPException(
            status_code=400,
            detail="请先配置小程序 AppID 和 AppSecret",
        )

    try:
        code_bytes, code_content_type = await generate_miniapp_code(
            miniapp_config.miniapp_appid,
            miniapp_config.miniapp_appsecret,
            page="pages/package-detail/package-detail",
            scene=product_uuid.hex,
        )
    except WechatMiniProgramError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"生成小程序码失败: {str(exc)[:200]}",
        )

    safe_name = "".join(
        ch
        for ch in str(product.name or "package")
        if ch.isascii() and (ch.isalnum() or ch in ("-", "_"))
    )[:40] or "package"
    return Response(
        content=code_bytes,
        media_type=code_content_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'inline; filename="{safe_name}-qrcode.png"',
        },
    )


@router.post("/products")
async def create_product(
    data: ProductCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """新增商品"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID, uuid4
    tid = UUID(tenant_id_str)

    images = _normalize_product_images(data.images)
    cover = (data.image_url or "").strip()
    if not cover and images:
        cover = images[0]
    if cover and not images:
        images = [cover]

    product = Product(
        id=uuid4(),
        tenant_id=tid,
        name=data.name,
        original_price=data.original_price,
        special_price=data.special_price,
        package_details=data.package_details or "",
        sales_count=data.sales_count,
        is_active=data.is_active,
        image_url=cover,
        images=images,
        specs=normalize_specs(data.specs),
        vehicle_type=data.vehicle_type or "",
        vehicle_types=data.vehicle_types or [],
        sort_order=data.sort_order,
    )
    db.add(product)
    await db.commit()
    await db.refresh(product)

    return {"success": True, "id": product.id.hex, "message": "商品已创建"}


@router.put("/products/{product_id}")
async def update_product(
    product_id: str,
    data: ProductUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """更新商品"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(Product).where(Product.id == UUID(product_id), Product.tenant_id == tid)
    )
    product = result.scalar_one_or_none()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    if data.name is not None:
        product.name = data.name
    if data.original_price is not None:
        product.original_price = data.original_price
    if data.special_price is not None:
        product.special_price = data.special_price
    if data.package_details is not None:
        product.package_details = data.package_details
    if data.is_active is not None:
        product.is_active = data.is_active
    if data.images is not None:
        images = _normalize_product_images(data.images)
        cover = (data.image_url or "").strip() if data.image_url is not None else ""
        if not cover and images:
            cover = images[0]
        if cover and not images:
            images = [cover]
        product.images = images
        product.image_url = cover
    elif data.image_url is not None:
        cover = data.image_url.strip()
        product.image_url = cover
        product.images = [cover] if cover else []
    if data.vehicle_type is not None:
        product.vehicle_type = data.vehicle_type
    if data.vehicle_types is not None:
        product.vehicle_types = data.vehicle_types
    if data.sales_count is not None:
        product.sales_count = data.sales_count
    if data.sort_order is not None:
        product.sort_order = data.sort_order
    if data.specs is not None:
        product.specs = normalize_specs(data.specs)

    db.add(product)
    await db.commit()
    return {"success": True, "message": "商品已更新"}


@router.post("/products/upload-image")
async def upload_product_image(
    file: UploadFile = File(...),
    request: Request = None,
):
    """商户端：上传商品图片到 OSS，返回公网 URL

    小程序商品列表/详情直接使用该 URL，所以在后台换了图，前端立即生效。
    """
    tenant_id_str = _extract_tenant_id(request)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="图片不能超过 5MB")

    img_type = _detect_image_type(content, file.filename)
    if img_type not in ("jpeg", "png", "gif", "webp", "bmp"):
        raise HTTPException(status_code=400, detail="仅支持 jpg / png / gif / webp 图片")
    optimized = await _optimize_upload_or_400(
        content,
        profile="photo",
        max_dimension=1600,
    )
    ext = optimized.extension

    oss_path = f"tenants/{tenant_id_str}/products/{uuid_lib.uuid4().hex}.{ext}"
    try:
        url = oss_service.upload_file(
            optimized.data,
            oss_path,
            content_type=optimized.mime_type,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"图片上传失败: {str(e)[:200]}")

    public_url = _public_image_url(url)
    return {
        "success": True,
        "url": public_url,
        "image_url": public_url,
        "original_bytes": optimized.original_bytes,
        "optimized_bytes": optimized.optimized_bytes,
    }


@router.post("/welfare-qr/upload")
async def upload_welfare_qr(
    file: UploadFile = File(...),
    request: Request = None,
):
    """商户端：上传企业微信福利二维码到 OSS。"""
    tenant_id_str = _extract_tenant_id(request)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="二维码图片不能超过 5MB")

    img_type = _detect_image_type(content, file.filename)
    if img_type not in ("jpeg", "png", "webp"):
        raise HTTPException(status_code=400, detail="二维码仅支持 jpg / png / webp 图片")
    optimized = await _optimize_upload_or_400(
        content,
        profile="qr",
        max_dimension=900,
    )
    ext = optimized.extension

    oss_path = f"tenants/{tenant_id_str}/welfare/qrcode-{uuid_lib.uuid4().hex}.{ext}"
    try:
        url = oss_service.upload_file(
            optimized.data,
            oss_path,
            content_type=optimized.mime_type,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"二维码上传失败: {str(e)[:200]}")

    public_url = _public_image_url(url)
    return {
        "success": True,
        "url": public_url,
        "image_url": public_url,
        "original_bytes": optimized.original_bytes,
        "optimized_bytes": optimized.optimized_bytes,
    }


@router.post("/welfare-guide/upload")
async def upload_welfare_guide(
    file: UploadFile = File(...),
    request: Request = None,
):
    """商户端：上传福利引导页海报到 OSS。"""
    tenant_id_str = _extract_tenant_id(request)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="引导海报不能超过 5MB")

    img_type = _detect_image_type(content, file.filename)
    if img_type not in ("jpeg", "png", "webp"):
        raise HTTPException(status_code=400, detail="引导海报仅支持 jpg / png / webp 图片")
    optimized = await _optimize_upload_or_400(
        content,
        profile="photo",
        max_dimension=1600,
    )
    ext = optimized.extension

    oss_path = f"tenants/{tenant_id_str}/welfare/guide-{uuid_lib.uuid4().hex}.{ext}"
    try:
        url = oss_service.upload_file(
            optimized.data,
            oss_path,
            content_type=optimized.mime_type,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"引导海报上传失败: {str(e)[:200]}")

    public_url = _public_image_url(url)
    return {
        "success": True,
        "url": public_url,
        "image_url": public_url,
        "original_bytes": optimized.original_bytes,
        "optimized_bytes": optimized.optimized_bytes,
        "width": optimized.width,
        "height": optimized.height,
    }


@router.delete("/products/{product_id}")
async def delete_product(
    product_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除商品"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(Product).where(Product.id == UUID(product_id), Product.tenant_id == tid)
    )
    product = result.scalar_one_or_none()
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")

    await db.delete(product)
    await db.commit()
    return {"success": True, "message": "商品已删除"}


# ── 商城订单管理 ──

def _mall_order_admin_status(order: MallOrder) -> str:
    """后台订单状态，比小程序用户端多区分待发货和已发货。"""
    if order.status == "cancelled":
        return "cancelled"
    if order.status in ("refunding", "refunded"):
        return "aftersale"
    if order.status == "completed":
        return "completed"
    if order.payment_status != "paid":
        return "pending_payment"
    if order.status == "shipped":
        return "shipped"
    return "pending_shipment"


def _mall_order_status_text(status_key: str) -> str:
    return {
        "pending_payment": "待支付",
        "pending_shipment": "待发货",
        "shipped": "已发货",
        "aftersale": "售后中",
        "completed": "已完成",
        "cancelled": "已取消",
    }.get(status_key, status_key or "未知")


def _as_utc(value):
    if not value:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _mall_order_merchant_json(
    order: MallOrder,
    profile: TenantUserProfile | None = None,
) -> dict:
    status_key = _mall_order_admin_status(order)
    raw_items = order.items if isinstance(order.items, list) else []
    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        items.append({
            "id": str(item.get("id", "") or ""),
            "title": str(item.get("title", "") or ""),
            "price": float(item.get("price") or 0),
            "qty": int(item.get("qty") or 1),
            "cover": _public_image_url(str(item.get("cover", "") or "")),
            "spec": str(item.get("spec", "") or ""),
        })

    return {
        "id": order.id.hex,
        "out_trade_no": order.out_trade_no or "",
        "transaction_id": order.transaction_id or "",
        "items": items,
        "item_count": order.item_count or sum(item["qty"] for item in items),
        "total_amount": float(order.total_amount or 0),
        "shipping_fee": float(order.shipping_fee or 0),
        "coupon_discount": float(order.coupon_discount or 0),
        "final_amount": float(order.final_amount or 0),
        "receiver_name": order.receiver_name or "",
        "receiver_phone": order.receiver_phone or "",
        "receiver_region": order.receiver_region or "",
        "receiver_detail": order.receiver_detail or "",
        "status": order.status or "pending",
        "status_key": status_key,
        "status_text": _mall_order_status_text(status_key),
        "payment_status": order.payment_status or "unpaid",
        "payment_status_text": "已支付" if order.payment_status == "paid" else "未支付",
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
        "updated_at": order.updated_at.isoformat() if order.updated_at else None,
        "user": {
            "id": profile.id.hex if profile else "",
            "nickname": profile.nickname if profile and profile.nickname else "微信用户",
            "avatar_url": profile.avatar_url if profile else "",
            "phone": profile.phone if profile else "",
        },
    }


async def _load_tenant_mall_orders(
    db: AsyncSession,
    tenant_id: str,
) -> list[tuple[MallOrder, TenantUserProfile | None]]:
    from uuid import UUID

    rows = await db.execute(
        select(MallOrder, TenantUserProfile)
        .outerjoin(TenantUserProfile, MallOrder.profile_id == TenantUserProfile.id)
        .where(MallOrder.tenant_id == UUID(tenant_id))
        .order_by(MallOrder.created_at.desc())
    )
    return list(rows.all())


def _mall_order_search_text(
    order: MallOrder,
    profile: TenantUserProfile | None,
) -> str:
    item_titles = " ".join(
        str(item.get("title", "") or "")
        for item in (order.items if isinstance(order.items, list) else [])
        if isinstance(item, dict)
    )
    return " ".join([
        order.out_trade_no or "",
        order.transaction_id or "",
        order.receiver_name or "",
        order.receiver_phone or "",
        order.receiver_region or "",
        order.receiver_detail or "",
        profile.nickname if profile else "",
        profile.phone if profile else "",
        item_titles,
    ]).lower()


def _mall_order_matches_status(order: MallOrder, status: str) -> bool:
    if not status or status == "all":
        return True
    return _mall_order_admin_status(order) == status


@router.get("/mall-orders/stats")
async def mall_order_stats(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """菜谱商城订单统计。"""
    tenant_id_str = _extract_tenant_id(request)
    rows = await _load_tenant_mall_orders(db, tenant_id_str)
    now_utc = datetime.now(timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        local_now = now_utc.astimezone(ZoneInfo("Asia/Shanghai"))
    except Exception:
        local_now = now_utc
    today_start = local_now.replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc)

    counts = {
        "all": len(rows),
        "pending_payment": 0,
        "pending_shipment": 0,
        "shipped": 0,
        "aftersale": 0,
        "completed": 0,
        "cancelled": 0,
    }
    summary = {
        "today_orders": 0,
        "today_paid_orders": 0,
        "today_revenue": 0.0,
        "total_revenue": 0.0,
        "paid_orders": 0,
    }

    for order, _profile in rows:
        status_key = _mall_order_admin_status(order)
        if status_key in counts:
            counts[status_key] += 1

        created_at = _as_utc(order.created_at)
        if created_at and created_at >= today_start:
            summary["today_orders"] += 1

        is_revenue_order = (
            order.payment_status == "paid"
            and order.status not in ("cancelled", "refunding", "refunded")
        )
        if is_revenue_order:
            amount = float(order.final_amount or 0)
            summary["paid_orders"] += 1
            summary["total_revenue"] += amount
            paid_at = _as_utc(order.paid_at or order.created_at)
            if paid_at and paid_at >= today_start:
                summary["today_paid_orders"] += 1
                summary["today_revenue"] += amount

    summary["today_revenue"] = round(summary["today_revenue"], 2)
    summary["total_revenue"] = round(summary["total_revenue"], 2)
    return {"counts": counts, "summary": summary}


@router.get("/mall-orders")
async def list_mall_orders_for_tenant(
    request: Request,
    db: AsyncSession = Depends(get_db),
    status: str = Query("all"),
    search: str = Query("", max_length=100),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
):
    """菜谱商城订单列表（商家视角）。"""
    tenant_id_str = _extract_tenant_id(request)
    rows = await _load_tenant_mall_orders(db, tenant_id_str)
    keyword = search.strip().lower()

    filtered = []
    for order, profile in rows:
        if not _mall_order_matches_status(order, status):
            continue
        if keyword and keyword not in _mall_order_search_text(order, profile):
            continue
        filtered.append(_mall_order_merchant_json(order, profile))

    total = len(filtered)
    start = (page - 1) * page_size
    return {
        "items": filtered[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


async def _get_tenant_mall_order(
    db: AsyncSession,
    tenant_id: str,
    order_id: str,
) -> MallOrder:
    from uuid import UUID

    try:
        oid = UUID(order_id)
        tid = UUID(tenant_id)
    except Exception:
        raise HTTPException(status_code=404, detail="订单不存在")
    order = (await db.execute(
        select(MallOrder).where(
            MallOrder.id == oid,
            MallOrder.tenant_id == tid,
        )
    )).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在")
    return order


@router.post("/mall-orders/{order_id}/ship")
async def ship_mall_order(
    order_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商家将已支付订单标记为已发货。"""
    tenant_id_str = _extract_tenant_id(request)
    order = await _get_tenant_mall_order(db, tenant_id_str, order_id)
    if order.payment_status != "paid":
        raise HTTPException(status_code=400, detail="订单尚未支付")
    if order.status != "pending":
        raise HTTPException(status_code=400, detail="当前订单状态不能发货")
    order.status = "shipped"
    await db.commit()
    await db.refresh(order)
    return {"success": True, "message": "订单已标记发货"}


@router.post("/mall-orders/{order_id}/complete")
async def complete_mall_order(
    order_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商家确认订单已完成。"""
    tenant_id_str = _extract_tenant_id(request)
    order = await _get_tenant_mall_order(db, tenant_id_str, order_id)
    if order.status != "shipped":
        raise HTTPException(status_code=400, detail="请先将订单标记为已发货")
    order.status = "completed"
    await db.commit()
    await db.refresh(order)
    return {"success": True, "message": "订单已完成"}


@router.post("/mall-orders/{order_id}/cancel")
async def cancel_mall_order_for_tenant(
    order_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商家取消未支付订单。"""
    tenant_id_str = _extract_tenant_id(request)
    order = await _get_tenant_mall_order(db, tenant_id_str, order_id)
    if order.payment_status == "paid":
        raise HTTPException(status_code=400, detail="已支付订单不能直接取消")
    if order.status != "cancelled":
        order.status = "cancelled"
        await db.commit()
    return {"success": True, "message": "订单已取消"}


# ── 小程序配置 ──

class MiniappConfigUpdate(BaseModel):
    """小程序配置更新"""
    app_id: Optional[str] = None
    app_secret: Optional[str] = None
    douyin_app_id: Optional[str] = None
    douyin_app_secret: Optional[str] = None
    template_id: Optional[str] = None
    navigation_bar_title: Optional[str] = None
    navigation_bar_color: Optional[str] = None
    bg_color: Optional[str] = None
    oss_base_path: Optional[str] = None
    is_published: Optional[bool] = None
    share_title: Optional[str] = None
    share_image: Optional[str] = None
    home_banner_image: Optional[str] = None
    welfare_guide_image: Optional[str] = None
    welfare_qr_image: Optional[str] = None


@router.get("/miniapp-config")
async def get_miniapp_config(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取商户小程序配置"""
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    row = await db.execute(select(Tenant).where(Tenant.id == tid))
    t = row.scalar_one_or_none()
    if not t:
        return {"success": False, "message": "商户不存在"}

    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})

    return {
        "app_id": settings.get("app_id", ""),
        "app_secret": "****" if settings.get("app_secret") else "",
        "douyin_app_id": settings.get("douyin_app_id", ""),
        "douyin_app_secret": "****" if settings.get("douyin_app_secret") else "",
        "template_id": settings.get("template_id", ""),
        "navigation_bar_title": settings.get("navigation_bar_title", ""),
        "navigation_bar_color": settings.get("navigation_bar_color", ""),
        "bg_color": settings.get("bg_color", ""),
        "oss_base_path": settings.get("oss_base_path", ""),
        "is_published": settings.get("is_published", False),
        "share_title": settings.get("share_title", ""),
        "share_image": settings.get("share_image", ""),
        "home_banner_image": settings.get("home_banner_image", ""),
        "welfare_guide_image": settings.get("welfare_guide_image", ""),
        "welfare_guide_url_link": settings.get("welfare_guide_url_link", ""),
        "welfare_qr_image": settings.get("welfare_qr_image", ""),
    }


@router.put("/miniapp-config")
async def upsert_miniapp_config(
    data: MiniappConfigUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """更新商户小程序配置（同步写入 Tenant.settings + TenantMiniappConfig）"""
    from app.models.all import TenantMiniappConfig
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    row = await db.execute(select(Tenant).where(Tenant.id == tid))
    t = row.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="商户不存在")

    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})

    update_map = data.model_dump(exclude_none=True)
    raw_api_v3_key = update_map.pop("wxpay_api_v3_key", None)
    if raw_api_v3_key is not None:
        api_v3_key = str(raw_api_v3_key).strip()
        if api_v3_key and not api_v3_key.startswith("****"):
            if len(api_v3_key) != 32:
                raise HTTPException(
                    status_code=400,
                    detail="微信支付 APIv3 密钥必须正好为 32 位",
                )
            update_map["wxpay_api_v3_key"] = api_v3_key
    for k, v in update_map.items():
        if v is not None:
            settings[k] = v

    t.settings = json.dumps(settings, ensure_ascii=False)
    db.add(t)

    # ── 同步写入 TenantMiniappConfig 表（供微信登录校验使用）──
    # ── 同步 is_published 状态 ──
    if "is_published" in update_map:
        cfg_row = await db.execute(select(TenantMiniappConfig).where(TenantMiniappConfig.tenant_id == tid))
        cfg = cfg_row.scalar_one_or_none()
        if cfg:
            cfg.is_published = data.is_published
            db.add(cfg)

    if "app_id" in update_map or "app_secret" in update_map or "douyin_app_id" in update_map or "douyin_app_secret" in update_map:
        cfg_row = await db.execute(select(TenantMiniappConfig).where(TenantMiniappConfig.tenant_id == tid))
        cfg = cfg_row.scalar_one_or_none()
        if cfg:
            if "app_id" in update_map:
                cfg.miniapp_appid = data.app_id
            if "app_secret" in update_map and data.app_secret:
                cfg.miniapp_appsecret = data.app_secret
            if "douyin_app_id" in update_map:
                cfg.douyin_appid = data.douyin_app_id
            if "douyin_app_secret" in update_map and data.douyin_app_secret:
                cfg.douyin_appsecret = data.douyin_app_secret
            db.add(cfg)
        else:
            cfg = TenantMiniappConfig(
                tenant_id=tid,
                miniapp_appid=data.app_id or "",
                miniapp_appsecret=data.app_secret or "",
                douyin_appid=data.douyin_app_id or "",
                douyin_appsecret=data.douyin_app_secret or "",
                is_published=True,
            )
            db.add(cfg)

    await db.commit()
    return {"success": True, "message": "配置已更新"}


@router.post("/miniapp-config/url-link")
async def create_miniapp_url_link(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """生成福利引导页的微信官方永久 URL Link。"""
    from app.models.all import TenantMiniappConfig
    from uuid import UUID

    tenant_id_str = _extract_tenant_id(request)
    try:
        tid = UUID(tenant_id_str)
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="商户登录信息无效")

    config_result = await db.execute(
        select(TenantMiniappConfig).where(TenantMiniappConfig.tenant_id == tid)
    )
    miniapp_config = config_result.scalar_one_or_none()
    if (
        not miniapp_config
        or not miniapp_config.miniapp_appid
        or not miniapp_config.miniapp_appsecret
    ):
        raise HTTPException(status_code=400, detail="请先配置小程序 AppID 和 AppSecret")

    try:
        url_link = await generate_miniapp_url_link(
            miniapp_config.miniapp_appid,
            miniapp_config.miniapp_appsecret,
            page="/pages/welfare-guide/index",
        )
    except WechatMiniProgramError as exc:
        raise HTTPException(status_code=502, detail=str(exc))
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"生成小程序专属链接失败: {str(exc)[:200]}",
        )

    tenant_result = await db.execute(select(Tenant).where(Tenant.id == tid))
    tenant = tenant_result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="商户不存在")

    settings = json.loads(tenant.settings) if isinstance(tenant.settings, str) else (tenant.settings or {})
    settings["welfare_guide_url_link"] = url_link
    tenant.settings = json.dumps(settings, ensure_ascii=False)
    db.add(tenant)
    await db.commit()

    return {
        "success": True,
        "url_link": url_link,
        "path": "/pages/welfare-guide/index",
        "expires": "never",
    }


# ── 微信支付配置（直接操作 TenantMiniappConfig 表）──


class WxpayConfigUpdate(BaseModel):
    """微信支付配置更新"""
    payment_name: Optional[str] = None
    payment_method: Optional[str] = None
    payment_type: Optional[str] = None
    miniapp_appid: Optional[str] = None
    wxpay_mchid: Optional[str] = None
    wxpay_api_v3_key: Optional[str] = None
    wxpay_cert_pem: Optional[str] = None
    wxpay_key_pem: Optional[str] = None
    wxpay_serial_no: Optional[str] = None
    wxpay_notify_url: Optional[str] = None


@router.get("/wxpay-config")
async def get_wxpay_config(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取商户微信支付配置"""
    from uuid import UUID
    from app.models.all import TenantMiniappConfig as _TMC
    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    row = await db.execute(select(_TMC).where(_TMC.tenant_id == tid))
    cfg = row.scalar_one_or_none()
    if not cfg:
        return {
            "payment_name": "微信支付",
            "payment_method": "wxpay",
            "payment_type": "JSAPI",
            "wxpay_mchid": "",
            "wxpay_api_v3_key": "",
            "wxpay_cert_pem": "",
            "wxpay_key_pem": "",
            "wxpay_serial_no": "",
            "wxpay_notify_url": "",
            "miniapp_appid": "",
            "has_config": False,
        }

    return {
        "payment_name": cfg.payment_name or "微信支付",
        "payment_method": cfg.payment_method or "wxpay",
        "payment_type": cfg.payment_type or "JSAPI",
        "wxpay_mchid": cfg.wxpay_mchid or "",
        "wxpay_api_v3_key": "****" if cfg.wxpay_api_v3_key else "",
        "wxpay_cert_pem": "****" if cfg.wxpay_cert_pem else "",
        "wxpay_key_pem": "****" if cfg.wxpay_key_pem else "",
        "wxpay_serial_no": cfg.wxpay_serial_no or "",
        "wxpay_notify_url": cfg.wxpay_notify_url or "",
        "miniapp_appid": cfg.miniapp_appid or "",
        "has_config": bool(cfg.wxpay_mchid and cfg.wxpay_api_v3_key and cfg.wxpay_key_pem and cfg.wxpay_serial_no),
    }


@router.put("/wxpay-config")
async def upsert_wxpay_config(
    data: WxpayConfigUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """更新商户微信支付配置"""
    from uuid import UUID
    from app.models.all import TenantMiniappConfig as _TMC
    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    # 查找或创建 TenantMiniappConfig
    row = await db.execute(select(_TMC).where(_TMC.tenant_id == tid))
    cfg = row.scalar_one_or_none()
    if not cfg:
        from uuid import uuid4
        cfg = _TMC(id=uuid4(), tenant_id=tid)
        db.add(cfg)

    update_map = data.model_dump(exclude_none=True)
    for k, v in update_map.items():
        if v is not None:
            setattr(cfg, k, v)

    # 自动从上传的 API 证书提取证书序列号（如果用户没有手动填写）
    if "wxpay_cert_pem" in update_map and not data.wxpay_serial_no:
        try:
            from cryptography import x509
            from cryptography.hazmat.primitives import serialization
            cert_pem = data.wxpay_cert_pem
            if not cert_pem.startswith("****"):
                cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
                serial_no_hex = format(cert.serial_number, "x")
                cfg.wxpay_serial_no = serial_no_hex
                print(f"[wxpay] 从证书自动提取序列号: {serial_no_hex}")
        except Exception as e:
            print(f"[wxpay] 自动提取证书序列号失败: {e}")

    # 保存后自动标记为已发布，否则 miniapp pay/create 查询 is_published=True 会找不到
    cfg.is_published = True

    await db.commit()
    return {"success": True, "message": "微信支付配置已更新"}


# ── OSS 文件替换 ──

@router.get("/oss/list")
async def tenant_oss_list(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """返回商户 OSS 目录下的文件列表"""
    import oss2
    from app.services import oss_service
    from app.core.config import get_settings

    tenant_id_str = _extract_tenant_id(request)
    settings = get_settings()
    base = await _get_tenant_oss_base(db, tenant_id_str)

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)
    bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)

    files = []
    for obj in oss2.ObjectIteratorV2(bucket, prefix=base + "/"):
        key = obj.key
        if key == base + "/":
            continue
        files.append({
            "key": key,
            "relative": key[len(base):].lstrip("/"),
            "size": obj.size,
            "last_modified": obj.last_modified,
        })
    return {"success": True, "files": files, "base": base}


@router.post("/oss/replace")
async def tenant_oss_replace(
    file: UploadFile = File(...),
    oss_path: str = Form(""),
    request: Request = None,
):
    """商户端：上传文件到 OSS（通用）"""
    from app.services import oss_service
    import imghdr

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")
    img_type = imghdr.what(None, content)
    content_type = f"image/{img_type}" if img_type else None
    result = oss_service.replace_and_refresh(oss_path, content, content_type)
    return result


# ── OSS 落地页信息 ──

@router.get("/oss/landing-page")
async def tenant_oss_landing_page(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：获取当前落地页图片 URL 和二维码 URL"""
    from app.models.all import KsLandingPage, Tenant
    from uuid import UUID
    import json

    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    # 最新落地页记录
    lp_row = await db.execute(
        select(KsLandingPage)
        .where(KsLandingPage.tenant_id == tid)
        .order_by(KsLandingPage.created_at.desc())
        .limit(1)
    )
    landing_page = lp_row.scalar_one_or_none()

    # 默认返回 OSS 直链（chl041701）
    settings = get_settings()
    bucket_domain = f"https://{settings.oss_bucket}.{settings.oss_endpoint}"
    base = await _get_tenant_oss_base(db, tenant_id_str)
    default_lp_url = f"{bucket_domain}/{base}/chl041701"

    image_url = landing_page.image_url if landing_page and landing_page.image_url else default_lp_url

    # 二维码 URL（从 settings 读取）
    t_row = await db.execute(select(Tenant).where(Tenant.id == tid))
    t = t_row.scalar_one_or_none()
    qr_url = ""
    if t and t.settings:
        s = json.loads(t.settings) if isinstance(t.settings, str) else t.settings
        qr_key = s.get("qr_oss_key", "")
        if qr_key:
            qr_url = f"{bucket_domain}/{qr_key}"

    return {
        "success": True,
        "landing_page": {"image_url": image_url},
        "qr_url": qr_url,
    }


# ── OSS 落地页替换 ──

@router.post("/oss/replace-landing-page")
async def tenant_oss_replace_landing_page(
    file: UploadFile = File(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """商户端：上传新图片替换落地页图片（上传到 OSS 并更新数据库）"""
    from app.models.all import KsLandingPage, Tenant
    from sqlalchemy import select
    import json

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")

    # 检测图片类型
    img_type = imghdr.what(None, content)
    content_type = f"image/{img_type}" if img_type else None

    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # 获取当前用户
    from app.core.security import decode_access_token as _decode_token
    _payload = _decode_token(
        request.headers.get("Authorization", "").replace("Bearer ", "")
        or request.cookies.get("tenant_token", "")
    )
    _user_id = _payload["sub"] if _payload and _payload.get("sub") else None
    _uid = UUID(_user_id) if _user_id else None

    # 获取商户快手账号（落地页需关联一个账号）
    from app.models.all import KsAccount as _KsAccount
    _acc_row = await db.execute(
        select(_KsAccount).where(_KsAccount.tenant_id == tid).limit(1)
    )
    _acc = _acc_row.scalar_one_or_none()
    _aid = _acc.id if _acc else None

    # 获取当前落地页信息
    lp_row = await db.execute(
        select(KsLandingPage)
        .where(KsLandingPage.tenant_id == tid)
        .order_by(KsLandingPage.created_at.desc())
        .limit(1)
    )
    landing_page = lp_row.scalar_one_or_none()

    settings = get_settings()
    bucket_domain = f"https://{settings.oss_bucket}.{settings.oss_endpoint}"
    base = await _get_tenant_oss_base(db, tenant_id_str)

    # 固定落地页文件名：chl041701（无后缀）
    filename = "chl041701"
    oss_key = f"{base}/{filename}"

    # 上传/替换 OSS 文件
    result = oss_service.replace_and_refresh(oss_key, content, content_type)
    if not result.get("success"):
        return result

    versioned_url, ver = oss_service.get_versioned_url(oss_key, result["url"])
    new_image_url = versioned_url

    # 更新数据库（有完整关联时才写 DB，否则只上传 OSS）
    if landing_page:
        landing_page.image_url = new_image_url
        await db.commit()
    elif _uid and _aid:
        new_lp = KsLandingPage(
            tenant_id=tid,
            user_id=_uid,
            account_id=_aid,
            title="落地页",
            image_url=new_image_url,
            status="draft",
        )
        db.add(new_lp)
        await db.commit()
    # ═══════ 同步写入商户图池（单图上传也入池） ═══════
    try:
        tenant_id_str_for_pool = _extract_tenant_id(request)
        pool_dir = _PROJECT_ROOT / "landing-images" / tenant_id_str_for_pool / "images"
        pool_dir.mkdir(parents=True, exist_ok=True)
        # 用 UUID 命名存到池中
        from app.services.landing_rotator import RotatorPaths as _RP, write_state as _write_state
        orig_name = file.filename or f"image.{img_type}" if img_type else "image.png"
        ext = os.path.splitext(orig_name)[1] or f".{img_type}" if img_type else ".png"
        pool_filename = f"{uuid_lib.uuid4().hex}{ext}"
        (pool_dir / pool_filename).write_bytes(content)
        # 更新 state
        images = sorted(pool_dir.iterdir())
        _write_state(_RP(tenant_id=tenant_id_str_for_pool), total=len(images))

        # 检查轮换进程是否假死，自动复活
        try:
            rp_for_check = _RP(tenant_id=tenant_id_str_for_pool)
            sp2 = Path(rp_for_check.state_file)
            if sp2.exists():
                s2 = json.loads(sp2.read_text())
                if s2.get("running"):
                    pid2 = s2.get("pid")
                    if pid2 and not os.path.exists(f"/proc/{pid2}"):
                        s2["running"] = False
                        s2["pid"] = None
                        _write_state(rp_for_check, running=False, pid=None)
                        oss_base = await _get_tenant_oss_base(db, tenant_id_str_for_pool)
                        # 读取固定文件名
                        oss_filename = ""
                        try:
                            from uuid import UUID as _UUID
                            _tr = await db.execute(select(Tenant).where(Tenant.id == _UUID(tenant_id_str_for_pool)))
                            _t = _tr.scalar_one_or_none()
                            if _t and _t.settings:
                                _s = json.loads(_t.settings) if isinstance(_t.settings, str) else _t.settings
                                oss_filename = _s.get("kuaishou_oss_filename", "").strip()
                        except Exception:
                            pass
                        script = os.path.join(_PROJECT_ROOT, "app/services/landing_rotator.py")
                        import asyncio, sys, logging
                        rotator_args = [
                            sys.executable, script,
                            "--tenant-id", tenant_id_str_for_pool,
                            "--oss-base", oss_base,
                        ]
                        if oss_filename:
                            rotator_args += ["--oss-filename", oss_filename]
                        asyncio.create_subprocess_exec(
                            *rotator_args,
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                            cwd=str(_PROJECT_ROOT),
                        )
                        logging.getLogger("tenant_landing").warning(
                            f"落地页上传检测到轮换进程已死(PID={pid2})，自动重启中"
                        )
        except Exception:
            pass
    except Exception as e:
        import logging
        logging.warning(f"单图上传同步入池失败（非致命）: {e}")

    # 无账号时仅上传 OSS 文件，不写 DB。刷新页面前端从 OSS URL 读取即可
    return {"success": True, "versioned_url": new_image_url, "version": ver}


# ═══════════════════════════════════════════════
# 多图轮换管理 — 商户版
# ═══════════════════════════════════════════════

import shutil
from app.services.landing_rotator import RotatorPaths, write_state, rotate_once as rot_rotate_once, rotate_to_index as rot_rotate_to_index

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _get_tenant_landing_dir(tenant_id: str) -> Path:
    """获取商户落地页轮换目录"""
    return _PROJECT_ROOT / "landing-images" / tenant_id


@router.get("/landing-images/list")
async def tenant_landing_images_list(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：获取图池列表"""
    tenant_id_str = _extract_tenant_id(request)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"
    state_file = tenant_dir / "state.json"

    images_dir.mkdir(parents=True, exist_ok=True)

    state = {}
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
        except Exception:
            pass

    # 读取图片启用状态
    meta_file = tenant_dir / "images_meta.json"
    images_meta = {}
    if meta_file.exists():
        try:
            images_meta = json.loads(meta_file.read_text())
        except Exception:
            pass

    # ── 计算 OSS 基础 URL 和固定文件名 ──
    oss_base, oss_filename = await _get_tenant_oss_config(db, tenant_id_str)
    settings_obj = get_settings()
    bucket_domain = f"https://{settings_obj.oss_bucket}.{settings_obj.oss_endpoint}"

    files = []
    versions = images_meta.get("versions", {}) if images_meta else {}
    if images_dir.exists():
        for f in sorted(images_dir.iterdir()):
            if f.is_file():
                meta = images_meta.get(f.name, {}) if images_meta else {}
                # OSS key：有固定文件名就用它，否则用本地文件名去后缀
                f_name = oss_filename or os.path.splitext(f.name)[0]
                oss_key = f"{oss_base}/{f_name}"
                ver = versions.get(f_name, 0) or int(f.stat().st_mtime * 1000)
                oss_url = f"{bucket_domain}/{oss_key}?v={ver}"
                files.append({
                    "filename": f.name,
                    "name": meta.get("name", ""),
                    "url": oss_url,
                    "local_url": f"/landing-images/{tenant_id_str}/images/{f.name}",
                    "oss_key": oss_key,
                    "size": f.stat().st_size,
                    "modified": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
                    "enabled": meta.get("enabled", True),
                })

    # 返回扁平的字段名，与前端 JS 期望一致 (images/running/pid/interval_sec/current_index/total)
    return {
        "success": True,
        "images": files,
        "running": state.get("running", False),
        "pid": state.get("pid", 0),
        "interval_sec": state.get("interval_sec", 10),
        "current_index": state.get("current", state.get("current_index", 0)),
        "total": state.get("total", len(files)),
    }


@router.post("/landing-images/upload")
async def tenant_landing_images_upload(
    file: UploadFile = File(...),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """商户端：上传图片到商户图池（本地 + OSS 双写，返回 OSS URL）

    OSS Key 规则：{oss_base}/{原始文件名去后缀}（固定覆盖，无时间戳）
    OSS URL 末尾带 ?v=N 递增版本号，每次上传 +1
    """

    tenant_id_str = _extract_tenant_id(request)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件内容为空")

    # ── 检测图片类型（兼容无后缀、非标准后缀的文件） ──
    img_type = _detect_image_type(content, file.filename)
    content_type = f"image/{img_type}"

    # ── 原始文件名去后缀、去特殊字符 ──
    original_name = file.filename or "image"
    safe_name = _sanitize_filename(original_name)
    name_without_ext = os.path.splitext(safe_name)[0] if "." in safe_name else safe_name
    if not name_without_ext:
        name_without_ext = "image"

    # 本地保存用：原始名.扩展名（同名覆盖）
    filename = f"{name_without_ext}.{img_type}"
    filepath = images_dir / filename
    filepath.write_bytes(content)

    # 更新 state
    rp = RotatorPaths(tenant_id=tenant_id_str)
    images = sorted(images_dir.iterdir())
    write_state(rp, total=len(images))

    # ── 确定 OSS 文件名：优先用商户配置的固定名 ──
    oss_name = name_without_ext
    oss_base, oss_filename = await _get_tenant_oss_config(db, tenant_id_str)
    if oss_filename:
        oss_name = oss_filename

    # ── 版本号管理（images_meta.json，按 oss_name 计数）──
    meta_file = tenant_dir / "images_meta.json"
    images_meta = {}
    if meta_file.exists():
        try:
            images_meta = json.loads(meta_file.read_text())
        except Exception:
            pass
    versions = images_meta.get("versions", {})
    old_ver = versions.get(oss_name, 0)
    new_ver = old_ver + 1
    versions[oss_name] = new_ver
    images_meta["versions"] = versions
    meta_file.write_text(json.dumps(images_meta, ensure_ascii=False))

    # ── 图片存入本地图池（OSS 由轮换器按固定文件名推送） ──
    settings = get_settings()
    bucket_domain = f"https://{settings.oss_bucket}.{settings.oss_endpoint}"
    oss_key = f"{oss_base}/{oss_name}"
    oss_url = f"{bucket_domain}/{oss_key}?v={new_ver}"

    # 检查轮换进程是否假死，自动复活
    try:
        state_path2 = Path(rp.state_file)
        if state_path2.exists():
            s2 = json.loads(state_path2.read_text())
            if s2.get("running"):
                pid2 = s2.get("pid")
                if pid2 and not os.path.exists(f"/proc/{pid2}"):
                    import asyncio, sys, logging
                    s2["running"] = False
                    s2["pid"] = None
                    write_state(rp, running=False, pid=None)
                    logging.getLogger("tenant_landing").warning(
                        f"检测到轮换进程已死(PID={pid2})，正在自动重启..."
                    )
                    script = os.path.join(_PROJECT_ROOT, "app/services/landing_rotator.py")
                    rotator_args = [
                        sys.executable, script,
                        "--tenant-id", tenant_id_str,
                        "--oss-base", oss_base,
                    ]
                    if oss_filename:
                        rotator_args += ["--oss-filename", oss_filename]
                    asyncio.create_subprocess_exec(
                        *rotator_args,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                        cwd=str(_PROJECT_ROOT),
                    )
    except Exception:
        pass

    return {
        "success": True,
        "filename": filename,
        "path": str(filepath),
        "oss_url": oss_url,
        "oss_key": oss_key,
        "total": len(images),
    }


@router.delete("/landing-images/{filename}")
async def tenant_landing_images_delete(
    filename: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：删除图池中的图片"""
    tenant_id_str = _extract_tenant_id(request)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"
    filepath = images_dir / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    if not filepath.is_file():
        raise HTTPException(status_code=400, detail="非文件类型")

    filepath.unlink()

    # 更新 state
    rp = RotatorPaths(tenant_id=tenant_id_str)
    images = sorted(images_dir.iterdir()) if images_dir.exists() else []
    write_state(rp, total=len(images))

    return {"success": True, "total": len(images)}


@router.put("/landing-images/{filename}/toggle")
async def tenant_landing_images_toggle(
    filename: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：切换图片展示状态（开启展示/关闭不展示）"""
    tenant_id_str = _extract_tenant_id(request)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"
    filepath = images_dir / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    meta_file = tenant_dir / "images_meta.json"
    images_meta = {}
    if meta_file.exists():
        try:
            images_meta = json.loads(meta_file.read_text())
        except Exception:
            pass

    current = images_meta.get(filename, {}).get("enabled", True)
    images_meta[filename] = {"enabled": not current}
    meta_file.write_text(json.dumps(images_meta, ensure_ascii=False, indent=2))

    return {
        "success": True,
        "filename": filename,
        "enabled": not current,
        "message": f"图片已{'开启展示' if not current else '关闭展示'}",
    }


@router.put("/landing-images/{filename}/rename")
async def tenant_landing_images_rename(
    filename: str,
    data: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：修改图片别名（用于区分上传的二维码/图片）"""
    tenant_id_str = _extract_tenant_id(request)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"
    filepath = images_dir / filename

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="文件不存在")

    new_name = (data.get("name") or "").strip()
    if len(new_name) > 100:
        raise HTTPException(status_code=400, detail="名称不能超过 100 个字符")

    meta_file = tenant_dir / "images_meta.json"
    images_meta = {}
    if meta_file.exists():
        try:
            images_meta = json.loads(meta_file.read_text())
        except Exception:
            pass

    existing = images_meta.get(filename, {})
    existing["name"] = new_name
    images_meta[filename] = existing
    meta_file.write_text(json.dumps(images_meta, ensure_ascii=False, indent=2))

    return {
        "success": True,
        "filename": filename,
        "name": new_name,
        "message": f"图片名称已更新为「{new_name or '(空)'}」",
    }


@router.put("/landing-images/config")
async def tenant_landing_images_config(
    data: dict,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：更新轮换配置"""
    tenant_id_str = _extract_tenant_id(request)
    rp = RotatorPaths(tenant_id=tenant_id_str)

    update = {}
    if "interval_sec" in data:
        val = int(data["interval_sec"])
        if val < 3 or val > 3600:
            raise HTTPException(status_code=400, detail="间隔需在 3~3600 秒之间")
        update["interval_sec"] = val

    if not update:
        raise HTTPException(status_code=400, detail="未提供有效配置项")

    write_state(rp, **update)
    return {"success": True, "message": "配置已更新"}


@router.post("/landing-images/rotator/start")
async def tenant_landing_rotator_start(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：启动轮换守护进程"""
    tenant_id_str = _extract_tenant_id(request)
    rp = RotatorPaths(tenant_id=tenant_id_str)
    tenant_dir = _get_tenant_landing_dir(tenant_id_str)
    images_dir = tenant_dir / "images"

    # 检查是否已在运行
    state_path = Path(rp.state_file)
    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            pass

    if state.get("running"):
        pid = state.get("pid")
        if pid and not os.path.exists(f"/proc/{pid}"):
            # PID 已死，清理假死状态后继续启动
            state["running"] = False
            state["pid"] = None
            write_state(rp, running=False, pid=None)
        else:
            return {"success": False, "message": "轮换进程已在运行"}

    # 检查图池
    images_dir.mkdir(parents=True, exist_ok=True)
    images = sorted(images_dir.iterdir())
    if len(images) < 2:
        return {"success": False, "message": f"图池不足（{len(images)} 张），至少需 2 张"}

    # 获取商户 OSS 配置
    oss_base = await _get_tenant_oss_base(db, tenant_id_str)
    _, oss_filename = await _get_tenant_oss_config(db, tenant_id_str)

    # 后台启动轮换进程
    script = os.path.join(_PROJECT_ROOT, "app/services/landing_rotator.py")
    rotator_args = [
        sys.executable, script,
        "--tenant-id", tenant_id_str,
        "--oss-base", oss_base,
    ]
    if oss_filename:
        rotator_args += ["--oss-filename", oss_filename]
    proc = await asyncio.create_subprocess_exec(
        *rotator_args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        cwd=str(_PROJECT_ROOT),
    )

    # 等待 1 秒检查是否成功启动
    await asyncio.sleep(1)

    # 重新读取状态
    state_path2 = Path(rp.state_file)
    if state_path2.exists():
        try:
            state = json.loads(state_path2.read_text())
        except Exception:
            pass

    if state.get("running"):
        return {
            "success": True,
            "pid": state.get("pid"),
            "message": f"轮换进程已启动（间隔 {state.get('interval_sec', 10)} 秒）",
        }

    return {"success": False, "message": "进程启动失败，请检查日志"}


@router.post("/landing-images/rotator/stop")
async def tenant_landing_rotator_stop(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """商户端：停止轮换守护进程"""
    tenant_id_str = _extract_tenant_id(request)
    rp = RotatorPaths(tenant_id=tenant_id_str)
    state_path = Path(rp.state_file)

    state = {}
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text())
        except Exception:
            pass

    pid = state.get("pid")
    if not pid:
        return {"success": False, "message": "没有正在运行的轮换进程"}

    try:
        os.kill(pid, 15)  # SIGTERM
    except ProcessLookupError:
        pass
    except Exception as e:
        return {"success": False, "message": f"停止失败: {e}"}

    # 更新状态
    write_state(rp, running=False, pid=None)

    return {"success": True, "message": "轮换守护进程已停止"}


@router.post("/landing-images/rotate/sync")
async def tenant_landing_rotate_sync(
    target: int = Form(-1),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """商户端：立即同步到下一张或指定索引的图片到 OSS"""
    tenant_id_str = _extract_tenant_id(request)
    rp = RotatorPaths(tenant_id=tenant_id_str)
    import logging
    _log = logging.getLogger("tenant_landing_sync")

    if target >= 0:
        result = rot_rotate_to_index(target, rp, logger=_log)
    else:
        result = rot_rotate_once(rp, logger=_log)

    return result


@router.get("/landing-images/rotator/log")
async def tenant_landing_rotator_log(
    lines: int = Query(50, ge=10, le=500),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """商户端：查看轮换守护进程日志"""
    tenant_id_str = _extract_tenant_id(request)
    rp = RotatorPaths(tenant_id=tenant_id_str)
    log_path = Path(rp.log_file)

    if not log_path.exists():
        return {"success": True, "log": "暂无日志"}

    try:
        content = log_path.read_text(encoding="utf-8")
        log_lines = content.strip().split("\n")
        last_lines = log_lines[-lines:]
        return {
            "success": True,
            "log": "\n".join(last_lines),
            "total_lines": len(log_lines),
        }
    except Exception as e:
        return {"success": False, "message": f"读取日志失败: {e}"}


# ═══════════════════════════════════════════════
# 菜谱商城：新人优惠券配置
# ═══════════════════════════════════════════════


class MallNewcomerCouponConfig(BaseModel):
    enabled: bool = True
    name: str = "新人专享券"
    description: str = "完成头像和昵称绑定后自动发放"
    discount_value: float = 20.0
    min_amount: float = 99.0
    valid_days: int = 30
    total_quantity: int = 0


def _mall_coupon_config_json(template: MallCouponTemplate | None) -> dict:
    return {
        "configured": bool(template),
        "enabled": bool(template.is_active) if template else False,
        "name": template.name if template else "新人专享券",
        "description": (template.description or "") if template else "完成头像和昵称绑定后自动发放",
        "discount_type": "fixed",
        "discount_value": float(template.discount_value or 0) if template else 20.0,
        "min_amount": float(template.min_amount or 0) if template else 99.0,
        "valid_days": int(template.valid_days or 30) if template else 30,
        "total_quantity": int(template.total_quantity or 0) if template else 0,
    }


@router.get("/mall-coupon-template")
async def get_mall_coupon_template(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    tid = uuid_lib.UUID(_extract_tenant_id(request))
    template = (await db.execute(
        select(MallCouponTemplate).where(
            MallCouponTemplate.tenant_id == tid,
            MallCouponTemplate.campaign_key == "newcomer",
        )
    )).scalar_one_or_none()

    stats = {"issued": 0, "unused": 0, "used": 0, "expired": 0}
    if template:
        rows = (await db.execute(
            select(MallUserCoupon.status, func.count(MallUserCoupon.id))
            .where(MallUserCoupon.template_id == template.id)
            .group_by(MallUserCoupon.status)
        )).all()
        status_counts = {status: int(count or 0) for status, count in rows}
        stats = {
            "issued": sum(status_counts.values()),
            "unused": status_counts.get("unused", 0),
            "used": status_counts.get("used", 0),
            "expired": status_counts.get("expired", 0),
        }

    return {
        "config": _mall_coupon_config_json(template),
        "stats": stats,
    }


@router.put("/mall-coupon-template")
async def save_mall_coupon_template(
    data: MallNewcomerCouponConfig,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    tid = uuid_lib.UUID(_extract_tenant_id(request))
    discount_value = round(float(data.discount_value or 0), 2)
    min_amount = round(float(data.min_amount or 0), 2)
    if discount_value <= 0:
        raise HTTPException(status_code=400, detail="优惠金额必须大于 0")
    if min_amount < 0:
        raise HTTPException(status_code=400, detail="使用门槛不能小于 0")
    if min_amount and discount_value >= min_amount:
        raise HTTPException(status_code=400, detail="优惠金额必须小于使用门槛")
    if data.valid_days < 1 or data.valid_days > 365:
        raise HTTPException(status_code=400, detail="有效天数需在 1 至 365 天之间")
    if data.total_quantity < 0:
        raise HTTPException(status_code=400, detail="发放总量不能小于 0")

    template = (await db.execute(
        select(MallCouponTemplate).where(
            MallCouponTemplate.tenant_id == tid,
            MallCouponTemplate.campaign_key == "newcomer",
        )
    )).scalar_one_or_none()
    if not template:
        template = MallCouponTemplate(
            id=uuid_lib.uuid4(),
            tenant_id=tid,
            campaign_key="newcomer",
        )
        db.add(template)

    template.name = data.name.strip() or "新人专享券"
    template.description = data.description.strip()
    template.discount_type = "fixed"
    template.discount_value = discount_value
    template.min_amount = min_amount
    template.valid_days = int(data.valid_days)
    template.total_quantity = int(data.total_quantity)
    template.is_active = bool(data.enabled)
    template.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(template)

    return {
        "success": True,
        "message": "新人券配置已保存",
        "config": _mall_coupon_config_json(template),
    }


# ═══════════════════════════════════════════════
# 插件：优惠券模板管理（Coupon Template CRUD）
# ═══════════════════════════════════════════════


class CouponTemplateCreate(BaseModel):
    name: str
    description: str = ""
    discount_type: str = "fixed"
    discount_value: float
    min_amount: float = 0.0
    is_newbie: bool = False
    total_quantity: int = 0
    per_user_limit: int = 1
    valid_days: int = 30
    sort_order: int = 0


class CouponTemplateUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    discount_type: Optional[str] = None
    discount_value: Optional[float] = None
    min_amount: Optional[float] = None
    is_newbie: Optional[bool] = None
    total_quantity: Optional[int] = None
    per_user_limit: Optional[int] = None
    valid_days: Optional[int] = None
    sort_order: Optional[int] = None
    is_active: Optional[bool] = None


@router.get("/coupon-templates")
async def list_coupon_templates(
    request: Request,
    page: int = Query(1),
    page_size: int = Query(15, le=100),
    search: str = Query(""),
    discount_type: str = Query(""),
    new_user_only: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    """获取商户所有优惠券模板列表 (分页+筛选)"""
    from app.models.all import CarWashCouponTemplate as _CT
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # Build filter conditions
    filters = [_CT.tenant_id == tid]
    if search:
        filters.append(_CT.name.ilike(f"%{search}%"))
    if discount_type:
        filters.append(_CT.discount_type == discount_type)
    if new_user_only:
        filters.append(_CT.is_newbie == (new_user_only.lower() in ("true", "1")))

    # Total count
    count_result = await db.execute(
        select(func.count(_CT.id)).where(*filters)
    )
    total = count_result.scalar() or 0

    # Fetch page
    offset_val = (page - 1) * page_size
    result = await db.execute(
        select(_CT)
        .where(*filters)
        .order_by(_CT.sort_order.asc(), _CT.created_at.desc())
        .offset(offset_val)
        .limit(page_size)
    )
    templates = result.scalars().all()

    items = [
        {
            "id": t.id.hex,
            "name": t.name,
            "description": t.description or "",
            "discount_type": t.discount_type,
            "discount_value": t.discount_value,
            "min_amount": t.min_amount,
            "is_newbie": t.is_newbie,
            "total_quantity": t.total_quantity,
            "per_user_limit": t.per_user_limit,
            "valid_days": t.valid_days,
            "sort_order": t.sort_order,
            "is_active": t.is_active,
            "created_at": t.created_at.isoformat() if t.created_at else None,
        }
        for t in templates
    ]

    return {"items": items, "total": total}


@router.post("/coupon-templates")
async def create_coupon_template(
    data: CouponTemplateCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """创建优惠券模板"""
    from app.models.all import CarWashCouponTemplate as _CT
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID, uuid4
    tid = UUID(tenant_id_str)

    template = _CT(
        id=uuid4(),
        tenant_id=tid,
        name=data.name,
        description=data.description,
        discount_type=data.discount_type,
        discount_value=data.discount_value,
        min_amount=data.min_amount,
        is_newbie=data.is_newbie,
        total_quantity=data.total_quantity,
        per_user_limit=data.per_user_limit,
        valid_days=data.valid_days,
        sort_order=data.sort_order,
    )
    db.add(template)
    await db.commit()

    return {"success": True, "id": template.id.hex, "message": "优惠券模板创建成功"}


@router.put("/coupon-templates/{template_id}")
async def update_coupon_template(
    template_id: str,
    data: CouponTemplateUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """编辑优惠券模板"""
    from app.models.all import CarWashCouponTemplate as _CT
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_CT).where(_CT.id == UUID(template_id), _CT.tenant_id == tid)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="优惠券模板不存在")

    update_map = data.model_dump(exclude_none=True)
    for k, v in update_map.items():
        setattr(template, k, v)

    db.add(template)
    await db.commit()
    return {"success": True, "message": "优惠券模板已更新"}


@router.delete("/coupon-templates/{template_id}")
async def delete_coupon_template(
    template_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除优惠券模板"""
    from app.models.all import CarWashCouponTemplate as _CT
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_CT).where(_CT.id == UUID(template_id), _CT.tenant_id == tid)
    )
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="优惠券模板不存在")

    await db.delete(template)
    await db.commit()
    return {"success": True, "message": "优惠券模板已删除"}


@router.get("/coupon-usage")
async def get_coupon_usage_stats(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """查看优惠券使用统计（每个模板被领取/使用/过期数量）"""
    from app.models.all import CarWashCouponTemplate as _CT
    from app.models.all import CarWashUserCoupon as _UC
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # 获取所有模板
    templates_result = await db.execute(
        select(_CT).where(_CT.tenant_id == tid)
    )
    templates = templates_result.scalars().all()

    stats = []
    for t in templates:
        tid_uuid = t.id
        # 统计领取数
        claimed = await db.execute(
            select(func.count(_UC.id)).where(_UC.template_id == tid_uuid)
        )
        claimed_count = claimed.scalar() or 0

        # 统计已使用
        used = await db.execute(
            select(func.count(_UC.id)).where(
                _UC.template_id == tid_uuid,
                _UC.status == "used",
            )
        )
        used_count = used.scalar() or 0

        # 统计已过期
        expired = await db.execute(
            select(func.count(_UC.id)).where(
                _UC.template_id == tid_uuid,
                _UC.status == "expired",
            )
        )
        expired_count = expired.scalar() or 0

        stats.append({
            "template_id": t.id.hex,
            "name": t.name,
            "claimed": claimed_count,
            "used": used_count,
            "expired": expired_count,
        })

    return {"success": True, "stats": stats, "total_coupons": len(templates), "total_issued": sum(s["claimed"] for s in stats), "total_used": sum(s["used"] for s in stats)}


# ═══════════════════════════════════════════════
# 插件：核销员管理（Verifier Management）
# ═══════════════════════════════════════════════


class VerifierCreate(BaseModel):
    profile_id: str
    store_id: Optional[str] = None


@router.get("/verifiers")
async def list_verifiers(
    request: Request,
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=200),
    search: Optional[str] = Query(None),
    store_name: Optional[str] = Query(None),
):
    """获取商户核销员列表（JOIN profiles + stores 查姓名和门店）"""
    from app.models.all import CarWashVerifier as _V
    from app.models.all import TenantUserProfile as _TUP
    from app.models.all import CarWashStore as _CS
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    base_q = select(_V, _TUP, _CS).join(_TUP, _V.profile_id == _TUP.id).join(
        _CS, _V.store_id == _CS.id, isouter=True
    ).where(_V.tenant_id == tid)

    if search:
        base_q = base_q.where(
            _TUP.nickname.ilike(f"%{search}%") | _TUP.phone.ilike(f"%{search}%")
        )

    # 克隆查询用于 count
    count_q = select(func.count()).select_from(_V).where(_V.tenant_id == tid)
    if search:
        count_q = count_q.where(
            _V.profile_id.in_(
                select(_TUP.id).where(
                    _TUP.nickname.ilike(f"%{search}%") | _TUP.phone.ilike(f"%{search}%")
                )
            )
        )

    total_result = await db.execute(count_q)
    total = total_result.scalar() or 0

    offset_val = (page - 1) * page_size
    result = await db.execute(
        base_q.order_by(_V.created_at.desc()).offset(offset_val).limit(page_size)
    )
    rows = result.all()

    items = [
        {
            "id": v.id.hex,
            "profile_id": v.profile_id.hex,
            "store_id": v.store_id.hex if v.store_id else None,
            "store_name": s.name if s else None,
            "is_active": v.is_active,
            "status": "active" if v.is_active else "disabled",
            "name": p.nickname or "",
            "phone": p.phone or "",
            "avatar_url": p.avatar_url or "",
            "created_at": v.created_at.isoformat() if v.created_at else None,
        }
        for v, p, s in rows
    ]

    return {
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
        "total_pages": max(1, (total + page_size - 1) // page_size),
    }


@router.post("/verifiers")
async def create_verifier(
    data: VerifierCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """添加核销员"""
    from app.models.all import CarWashVerifier as _V
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID, uuid4
    tid = UUID(tenant_id_str)

    # 检查该 profile 是否已经是核销员
    existing = await db.execute(
        select(_V).where(_V.profile_id == UUID(data.profile_id), _V.tenant_id == tid)
    )
    if existing.scalar_one_or_none():
        return {"success": False, "message": "该用户已经是核销员"}

    verifier = _V(
        id=uuid4(),
        profile_id=UUID(data.profile_id),
        tenant_id=tid,
        store_id=UUID(data.store_id) if data.store_id else None,
    )
    db.add(verifier)
    await db.commit()

    return {"success": True, "id": verifier.id.hex, "message": "核销员添加成功"}


@router.post("/verifiers/by-openid")
async def add_verifier_by_openid(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """通过openid添加核销员（查找TenantUserProfile）

    Body: { "openid": "xxx", "store_id": "optional-uuid" }
    """
    from app.models.all import CarWashVerifier as _V
    from app.models.all import TenantUserProfile as _TUP
    from uuid import UUID, uuid4

    body_data = await request.json()
    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    raw_openid = str(body_data.get("openid", "")).strip()
    if not raw_openid:
        raise HTTPException(status_code=400, detail="请提供openid")

    # 查找该openid对应的profile
    result = await db.execute(
        select(_TUP).where(
            _TUP.openid == raw_openid,
            _TUP.tenant_id == tid,
        )
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail=f"未找到openid={raw_openid}对应的用户")

    # 检查是否已是核销员
    existing = await db.execute(
        select(_V).where(_V.profile_id == profile.id, _V.tenant_id == tid)
    )
    existing_v = existing.scalar_one_or_none()
    if existing_v:
        return {"success": True, "message": "该用户已经是核销员", "id": existing_v.id.hex}

    store_uuid = None
    raw_store = body_data.get("store_id")
    if raw_store:
        try:
            store_uuid = UUID(raw_store)
        except Exception:
            store_uuid = None

    verifier = _V(
        id=uuid4(),
        profile_id=profile.id,
        tenant_id=tid,
        store_id=store_uuid,
    )
    db.add(verifier)
    await db.commit()

    return {
        "success": True,
        "id": verifier.id.hex,
        "nickname": profile.nickname or "",
        "message": f"核销员添加成功（{profile.nickname}）",
    }


@router.delete("/verifiers/{verifier_id}")
async def delete_verifier(
    verifier_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除核销员"""
    from app.models.all import CarWashVerifier as _V
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_V).where(_V.id == UUID(verifier_id), _V.tenant_id == tid)
    )
    verifier = result.scalar_one_or_none()
    if not verifier:
        raise HTTPException(status_code=404, detail="核销员不存在")

    await db.delete(verifier)
    await db.commit()
    return {"success": True, "message": "核销员已删除"}


@router.get("/verifier-candidates")
async def get_verifier_candidates(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """可设为核销员的用户列表（未设置过的 profile）"""
    from app.models.all import CarWashVerifier as _V
    from app.models.all import TenantUserProfile as _TUP
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # 已设为核销员的 profile_id 列表
    verifier_result = await db.execute(
        select(_V.profile_id).where(_V.tenant_id == tid)
    )
    existing_ids = {row[0] for row in verifier_result.all()}

    # 所有未设置的 profile
    result = await db.execute(
        select(_TUP).where(_TUP.tenant_id == tid).order_by(_TUP.created_at.desc())
    )
    profiles = result.scalars().all()

    candidates = [
        {
            "id": p.id.hex,
            "name": p.nickname or "",
            "phone": p.phone or "",
            "avatar_url": p.avatar_url or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in profiles if p.id not in existing_ids
    ]

    return {"success": True, "candidates": candidates}


# ═══════════════════════════════════════════════
# 插件：手机管理员管理（Mobile Manager Management）
# ═══════════════════════════════════════════════


class ManagerCreate(BaseModel):
    profile_id: str


@router.get("/managers")
async def list_managers(
    request: Request,
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=200),
    search: Optional[str] = Query(None),
):
    """获取商户手机管理员列表"""
    from app.models.all import CarWashManager as _M
    from app.models.all import TenantUserProfile as _TUP
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    base_q = select(_M, _TUP).join(_TUP, _M.profile_id == _TUP.id)

    where_clauses = [_M.tenant_id == tid]
    if search:
        search_filter = _TUP.nickname.ilike(f"%{search}%")
        where_clauses.append(search_filter)

    base_q = base_q.where(*where_clauses).order_by(_M.created_at.desc())

    # 计数
    count_q = select(func.count()).select_from(base_q.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    base_q = base_q.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(base_q)
    rows = result.all()

    items = []
    for m, p in rows:
        items.append({
            "id": m.id.hex,
            "profile_id": p.id.hex,
            "name": p.nickname or "",
            "phone": p.phone or "",
            "avatar_url": p.avatar_url or "",
            "is_active": m.is_active,
            "created_at": m.created_at.isoformat() if m.created_at else "",
        })

    return {
        "success": True,
        "items": items,
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.post("/managers")
async def add_manager_by_profile_id(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """通过 profile_id 添加手机管理员（候选人模式）"""
    from app.models.all import CarWashManager as _M
    from app.models.all import TenantUserProfile as _TUP
    from uuid import UUID, uuid4

    body_data = await request.json()
    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    profile_id = str(body_data.get("profile_id", "")).strip()
    profile_uuid = UUID(profile_id)
    # 验证profile存在
    result = await db.execute(
        select(_TUP).where(_TUP.id == profile_uuid, _TUP.tenant_id == tid)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="未找到该用户")

    # 检查是否已是管理员
    existing = await db.execute(
        select(_M).where(_M.profile_id == profile.id, _M.tenant_id == tid)
    )
    existing_m = existing.scalar_one_or_none()
    if existing_m:
        return {"success": True, "message": "该用户已经是手机管理员", "id": existing_m.id.hex}

    manager = _M(
        id=uuid4(),
        profile_id=profile.id,
        tenant_id=tid,
    )
    db.add(manager)
    await db.commit()

    return {
        "success": True,
        "id": manager.id.hex,
        "nickname": profile.nickname or "",
        "message": f"手机管理员添加成功（{profile.nickname}）",
    }


@router.post("/managers/by-openid")
async def add_manager_by_openid(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """通过 openid 添加手机管理员"""
    from app.models.all import CarWashManager as _M
    from app.models.all import TenantUserProfile as _TUP
    from uuid import UUID, uuid4

    body_data = await request.json()
    tenant_id_str = _extract_tenant_id(request)
    tid = UUID(tenant_id_str)

    raw_openid = str(body_data.get("openid", "")).strip()
    if not raw_openid:
        raise HTTPException(status_code=400, detail="请提供openid")

    # 查找该openid对应的profile
    result = await db.execute(
        select(_TUP).where(
            _TUP.openid == raw_openid,
            _TUP.tenant_id == tid,
        )
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail=f"未找到openid={raw_openid}对应的用户")

    # 检查是否已是管理员
    existing = await db.execute(
        select(_M).where(_M.profile_id == profile.id, _M.tenant_id == tid)
    )
    existing_m = existing.scalar_one_or_none()
    if existing_m:
        return {"success": True, "message": "该用户已经是手机管理员", "id": existing_m.id.hex}

    manager = _M(
        id=uuid4(),
        profile_id=profile.id,
        tenant_id=tid,
    )
    db.add(manager)
    await db.commit()

    return {
        "success": True,
        "id": manager.id.hex,
        "nickname": profile.nickname or "",
        "message": f"手机管理员添加成功（{profile.nickname}）",
    }


@router.delete("/managers/{manager_id}")
async def delete_manager(
    manager_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除手机管理员"""
    from app.models.all import CarWashManager as _M
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_M).where(_M.id == UUID(manager_id), _M.tenant_id == tid)
    )
    manager = result.scalar_one_or_none()
    if not manager:
        raise HTTPException(status_code=404, detail="管理员不存在")

    await db.delete(manager)
    await db.commit()
    return {"success": True, "message": "管理员已删除"}


@router.get("/manager-candidates")
async def get_manager_candidates(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """可设为手机管理员的用户列表（未设置过的 profile）"""
    from app.models.all import CarWashManager as _M
    from app.models.all import TenantUserProfile as _TUP
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    # 已设为管理员的 profile_id 列表
    mgr_result = await db.execute(
        select(_M.profile_id).where(_M.tenant_id == tid)
    )
    existing_ids = {row[0] for row in mgr_result.all()}

    # 所有未设置的 profile
    result = await db.execute(
        select(_TUP).where(_TUP.tenant_id == tid).order_by(_TUP.created_at.desc())
    )
    profiles = result.scalars().all()

    candidates = [
        {
            "id": p.id.hex,
            "name": p.nickname or "",
            "phone": p.phone or "",
            "avatar_url": p.avatar_url or "",
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in profiles if p.id not in existing_ids
    ]

    return {"success": True, "candidates": candidates}


# ═══════════════════════════════════════════════
# 插件：团购活动管理（Group Buy Activity CRUD）
# ═══════════════════════════════════════════════


class GroupBuyActivityCreate(BaseModel):
    product_id: Optional[str] = None
    name: str = ""
    description: str = ""
    original_price: float = 0.0
    group_price: float = 0.0
    min_group_size: int = 3
    max_group_size: int = 50
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    total_quantity: int = 0


class GroupBuyActivityUpdate(BaseModel):
    product_id: Optional[str] = None
    name: Optional[str] = None
    description: Optional[str] = None
    original_price: Optional[float] = None
    group_price: Optional[float] = None
    min_group_size: Optional[int] = None
    max_group_size: Optional[int] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    total_quantity: Optional[int] = None
    is_active: Optional[bool] = None


def _parse_dt_or_none(s: Optional[str]) -> Optional[datetime]:
    """解析 ISO 时间字符串为 datetime，None 或空返回 None"""
    if not s or not s.strip():
        return None
    try:
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


@router.get("/group-buy/activities")
async def list_group_buy_activities(
    request: Request,
    page: int = Query(1),
    page_size: int = Query(15, le=100),
    search: str = Query(""),
    status: str = Query(""),
    db: AsyncSession = Depends(get_db),
):
    """获取商户所有团购活动列表 (分页+筛选)"""
    from app.models.all import CarWashGroupBuyActivity as _GBA
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    from datetime import datetime, timezone
    tid = UUID(tenant_id_str)

    # Build filter conditions
    filters = [_GBA.tenant_id == tid]
    if search:
        filters.append(_GBA.name.ilike(f"%{search}%"))
    if status:
        now = datetime.now(timezone.utc)
        if status == "active":
            filters.append(_GBA.is_active == True)
            filters.append(_GBA.end_time > now)
        elif status == "paused":
            filters.append(_GBA.is_active == False)
        elif status == "ended":
            filters.append(_GBA.end_time <= now)

    # Total count
    count_result = await db.execute(
        select(func.count(_GBA.id)).where(*filters)
    )
    total = count_result.scalar() or 0

    # Fetch page
    offset_val = (page - 1) * page_size
    result = await db.execute(
        select(_GBA)
        .where(*filters)
        .order_by(_GBA.created_at.desc())
        .offset(offset_val)
        .limit(page_size)
    )
    activities = result.scalars().all()

    activity_ids = [activity.id.hex for activity in activities]
    paid_quantities = {}
    if activity_ids:
        paid_result = await db.execute(
            select(
                CarWashOrder.group_buy_activity_id,
                func.coalesce(func.sum(CarWashOrder.quantity), 0),
            ).where(
                CarWashOrder.tenant_id == tid,
                CarWashOrder.group_buy_activity_id.in_(activity_ids),
                CarWashOrder.payment_status == "paid",
                CarWashOrder.status.notin_(["cancelled", "canceled", "refunded"]),
            ).group_by(CarWashOrder.group_buy_activity_id)
        )
        paid_quantities = {activity_id: int(quantity or 0) for activity_id, quantity in paid_result.all()}

    items = [
        {
            "id": a.id.hex,
            "product_id": a.product_id.hex if a.product_id else None,
            "name": a.name,
            "description": a.description or "",
            "original_price": a.original_price,
            "group_price": a.group_price,
            "min_group_size": a.min_group_size,
            "max_group_size": a.max_group_size,
            "start_time": a.start_time.isoformat() if a.start_time else None,
            "end_time": a.end_time.isoformat() if a.end_time else None,
            "total_quantity": a.total_quantity,
            "sold_quantity": paid_quantities.get(a.id.hex, 0),
            "is_active": a.is_active,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in activities
    ]

    return {"items": items, "total": total}


@router.post("/group-buy/activities")
async def create_group_buy_activity(
    data: GroupBuyActivityCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """创建团购活动"""
    from app.models.all import CarWashGroupBuyActivity as _GBA
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID, uuid4
    tid = UUID(tenant_id_str)

    activity = _GBA(
        id=uuid4(),
        tenant_id=tid,
        product_id=UUID(data.product_id) if data.product_id else None,
        name=data.name,
        description=data.description,
        original_price=data.original_price,
        group_price=data.group_price,
        min_group_size=data.min_group_size,
        max_group_size=data.max_group_size,
        start_time=_parse_dt_or_none(data.start_time),
        end_time=_parse_dt_or_none(data.end_time),
        total_quantity=data.total_quantity,
    )
    db.add(activity)
    await db.commit()

    return {"success": True, "id": activity.id.hex, "message": "团购活动创建成功"}


@router.put("/group-buy/activities/{activity_id}")
async def update_group_buy_activity(
    activity_id: str,
    data: GroupBuyActivityUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """编辑团购活动"""
    from app.models.all import CarWashGroupBuyActivity as _GBA
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_GBA).where(_GBA.id == UUID(activity_id), _GBA.tenant_id == tid)
    )
    activity = result.scalar_one_or_none()
    if not activity:
        raise HTTPException(status_code=404, detail="团购活动不存在")

    update_map = data.model_dump(exclude_none=True)
    # 特殊处理外键和时间字段
    if "product_id" in update_map:
        update_map["product_id"] = UUID(update_map["product_id"]) if update_map["product_id"] else None
    if "start_time" in update_map:
        update_map["start_time"] = _parse_dt_or_none(update_map["start_time"])
    if "end_time" in update_map:
        update_map["end_time"] = _parse_dt_or_none(update_map["end_time"])

    for k, v in update_map.items():
        setattr(activity, k, v)

    db.add(activity)
    await db.commit()
    return {"success": True, "message": "团购活动已更新"}


@router.delete("/group-buy/activities/{activity_id}")
async def delete_group_buy_activity(
    activity_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """删除团购活动"""
    from app.models.all import CarWashGroupBuyActivity as _GBA
    tenant_id_str = _extract_tenant_id(request)
    from uuid import UUID
    tid = UUID(tenant_id_str)

    result = await db.execute(
        select(_GBA).where(_GBA.id == UUID(activity_id), _GBA.tenant_id == tid)
    )
    activity = result.scalar_one_or_none()
    if not activity:
        raise HTTPException(status_code=404, detail="团购活动不存在")

    await db.delete(activity)
    await db.commit()
    return {"success": True, "message": "团购活动已删除"}
