"""Hypit gateway integration for the SaaS application center."""
from __future__ import annotations

import base64
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.parse import quote
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.config import get_settings
from app.core.database import get_db
from app.core.security import decode_access_token
from app.models.all import Tenant, TenantMiniappConfig

router = APIRouter(prefix="/api/apps/gateway", tags=["apps-gateway"])


class GatewayTenantCreate(BaseModel):
    name: str = Field(..., min_length=2, max_length=100)
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=8, max_length=128)
    saas_tenant_id: Optional[str] = None


class GatewayBindRequest(BaseModel):
    saas_tenant_id: str
    gateway_tenant_id: str = ""


class GatewayRechargeRequest(BaseModel):
    amount_fen: int = Field(..., gt=0)
    description: str = "秒创云平台充值"


class GatewayWechatRechargeRequest(BaseModel):
    amount_fen: int = Field(..., ge=1, le=5_000_000)


class GatewayStatusRequest(BaseModel):
    status: str = Field(..., pattern=r"^(active|suspended)$")


class GatewayVoiceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    speaker_id: str = Field(..., min_length=1, max_length=200)


class GatewayTokenRequest(BaseModel):
    name: str = Field("秒创云 Studio", min_length=1, max_length=100)


class GatewayRechargeCodeRequest(BaseModel):
    amount_fen: int = Field(..., gt=0)
    tenant_id: Optional[str] = None


class GatewayRedeemRequest(BaseModel):
    code: str = Field(..., min_length=4, max_length=100)


class GatewayPriceRequest(BaseModel):
    unit_price_microfen: int = Field(..., ge=0)


def _require_admin(current_user: dict) -> None:
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="仅平台管理员可管理网关")


def _tenant_settings(tenant: Tenant) -> dict:
    if isinstance(tenant.settings, str):
        try:
            return json.loads(tenant.settings or "{}")
        except (TypeError, ValueError):
            return {}
    return tenant.settings or {}


def _tenant_role(request: Request) -> str:
    token = request.headers.get("Authorization", "").replace("Bearer ", "").strip()
    if not token:
        token = request.cookies.get("tenant_token", "")
    payload = decode_access_token(token) if token else None
    return str((payload or {}).get("role") or "")


def _require_tenant_admin(request: Request) -> None:
    if _tenant_role(request) != "admin":
        raise HTTPException(status_code=403, detail="仅商户管理员可执行此操作")


async def _gateway_call(
    method: str,
    path: str,
    *,
    json_body: Optional[dict[str, Any]] = None,
) -> Any:
    settings = get_settings()
    secret = settings.hypit_gateway_bridge_secret.strip()
    if not secret:
        raise HTTPException(status_code=503, detail="网关内部桥接密钥未配置")

    base_url = settings.hypit_gateway_base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=20.0,
            trust_env=False,
        ) as client:
            response = await client.request(
                method,
                path,
                headers={"X-Hypit-Bridge-Secret": secret},
                json=json_body,
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"网关服务不可用：{exc}") from exc

    if response.status_code in (401, 403):
        raise HTTPException(status_code=502, detail="网关内部桥接认证失败")
    if response.status_code >= 400:
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        message = payload.get("message") or payload.get("detail") or "网关请求失败"
        status = response.status_code if 400 <= response.status_code < 500 else 502
        raise HTTPException(status_code=status, detail=message)
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="网关返回了无效响应") from exc


async def _tenant_row(db: AsyncSession, tenant_id: str) -> Tenant:
    try:
        tid = UUID(str(tenant_id))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="无效的商户 ID") from exc
    result = await db.execute(select(Tenant).where(Tenant.id == tid))
    tenant = result.scalar_one_or_none()
    if not tenant:
        raise HTTPException(status_code=404, detail="商户不存在")
    return tenant


async def _tenant_gateway_id(
    db: AsyncSession,
    tenant: Tenant,
) -> str:
    settings = _tenant_settings(tenant)
    gateway_tenant_id = str(settings.get("gateway_tenant_id") or "").strip()
    if gateway_tenant_id:
        return gateway_tenant_id

    overview = await _gateway_call("GET", "/saas/v1/overview")
    matches = [
        item
        for item in overview.get("tenants", [])
        if str(item.get("name") or "").strip() == tenant.name.strip()
    ]
    if len(matches) != 1:
        raise HTTPException(
            status_code=409,
            detail="当前商户尚未绑定网关账户，请在平台总后台完成绑定",
        )

    gateway_tenant_id = str(matches[0]["id"])
    settings["gateway_tenant_id"] = gateway_tenant_id
    plugins = settings.get("plugins")
    if not isinstance(plugins, list):
        plugins = []
    if "gateway" not in plugins:
        plugins.append("gateway")
    settings["plugins"] = plugins
    tenant.settings = json.dumps(settings, ensure_ascii=False)
    await db.commit()
    return gateway_tenant_id


async def _gateway_wxpay_config(
    db: AsyncSession,
    *,
    require_published: bool = True,
) -> TenantMiniappConfig:
    source_name = get_settings().gateway_recharge_payment_tenant_name.strip()
    if not source_name:
        raise HTTPException(status_code=503, detail="AI 网关收款商户未配置")
    tenant_result = await db.execute(select(Tenant).where(Tenant.name == source_name))
    source_tenant = tenant_result.scalar_one_or_none()
    if not source_tenant:
        raise HTTPException(status_code=503, detail="AI 网关收款商户不存在")
    result = await db.execute(
        select(TenantMiniappConfig).where(
            TenantMiniappConfig.tenant_id == source_tenant.id
        )
    )
    cfg = result.scalar_one_or_none()
    if not cfg or (require_published and not cfg.is_published):
        raise HTTPException(status_code=400, detail="AI 网关收款商户尚未发布小程序支付配置")

    required = {
        "小程序 AppID": cfg.miniapp_appid,
        "微信支付商户号": cfg.wxpay_mchid,
        "APIv3 密钥": cfg.wxpay_api_v3_key,
        "商户私钥": cfg.wxpay_key_pem,
        "证书序列号": cfg.wxpay_serial_no,
    }
    missing = [label for label, value in required.items() if not str(value or "").strip()]
    if missing:
        raise HTTPException(
            status_code=400,
            detail="微信支付参数不完整：" + "、".join(missing),
        )
    return cfg


def _wechat_notify_url() -> str:
    base = get_settings().wxpay_notify_base_url.strip().rstrip("/")
    if not base:
        raise HTTPException(status_code=503, detail="微信支付回调基础地址未配置")
    return f"{base}/api/apps/gateway/tenant/recharge/wechat/notify"


def _wechat_public_key_config(cfg: TenantMiniappConfig) -> tuple[str, str]:
    settings = get_settings()
    key_path = settings.gateway_wxpay_public_key_path.strip()
    if key_path:
        try:
            public_key_pem = Path(key_path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise HTTPException(
                status_code=503,
                detail=f"无法读取 AI 网关微信支付公钥：{exc}",
            ) from exc
        return public_key_pem, settings.gateway_wxpay_public_key_id.strip()
    return (
        str(getattr(cfg, "wxpay_public_key_pem", "") or "").strip(),
        str(getattr(cfg, "wxpay_public_key_id", "") or "").strip(),
    )


def _gateway_payment_appid(cfg: TenantMiniappConfig) -> str:
    return (
        get_settings().gateway_wxpay_appid.strip()
        or str(cfg.miniapp_appid or "").strip()
    )


def _gateway_payment_api_v3_key(cfg: TenantMiniappConfig) -> str:
    return (
        get_settings().gateway_wxpay_api_v3_key.strip()
        or str(cfg.wxpay_api_v3_key or "").strip()
    )


async def _prepare_wechat_verifier(cfg: TenantMiniappConfig) -> str:
    from app.services.wxpay_service import (
        prepare_platform_signature_verification,
    )

    public_key_pem, public_key_id = _wechat_public_key_config(cfg)
    api_v3_key = _gateway_payment_api_v3_key(cfg)
    if len(api_v3_key) != 32:
        raise ValueError("AI 网关微信支付 APIv3 密钥必须正好为 32 位")
    return await prepare_platform_signature_verification(
        mchid=str(cfg.wxpay_mchid or "").strip(),
        serial_no=str(cfg.wxpay_serial_no or "").strip(),
        private_key_pem=str(cfg.wxpay_key_pem or ""),
        api_v3_key=api_v3_key,
        public_key_pem=public_key_pem,
        public_key_id=public_key_id,
    )


def _wechat_qr_data_url(code_url: str) -> str:
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
    except ImportError as exc:
        raise HTTPException(status_code=503, detail="微信支付二维码组件未安装") from exc

    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
        image_factory=SvgPathImage,
    )
    qr.add_data(code_url)
    qr.make(fit=True)
    buffer = io.BytesIO()
    qr.make_image().save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/svg+xml;base64,{encoded}"


async def _credit_wechat_recharge(
    order: dict[str, Any],
    cfg: TenantMiniappConfig,
    payment: dict[str, Any],
) -> Any:
    if str(payment.get("trade_state") or "").upper() != "SUCCESS":
        return None
    if str(payment.get("mchid") or "") != str(cfg.wxpay_mchid or ""):
        raise HTTPException(status_code=400, detail="微信支付商户号与当前订单不匹配")
    if str(payment.get("appid") or "") != _gateway_payment_appid(cfg):
        raise HTTPException(status_code=400, detail="微信支付 AppID 与当前订单不匹配")

    paid_amount = int((payment.get("amount") or {}).get("total") or 0)
    order_amount = int(order.get("amountFen") or 0)
    if paid_amount != order_amount:
        raise HTTPException(status_code=400, detail="微信支付金额与充值订单不匹配")

    provider_trade_no = str(payment.get("transaction_id") or "").strip()
    if not provider_trade_no:
        raise HTTPException(status_code=400, detail="微信支付结果缺少交易号")
    return await _gateway_call(
        "POST",
        f"/saas/v1/payment-orders/{quote(str(order['outTradeNo']), safe='')}/credit",
        json_body={
            "providerTradeNo": provider_trade_no,
            "paidAt": str(payment.get("success_time") or datetime.now(timezone.utc).isoformat()),
        },
    )


@router.get("/admin/overview")
async def admin_overview(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    overview = await _gateway_call("GET", "/saas/v1/overview")
    result = await db.execute(select(Tenant).order_by(Tenant.created_at.desc()))
    saas_tenants = []
    for tenant in result.scalars().all():
        settings = _tenant_settings(tenant)
        saas_tenants.append(
            {
                "id": str(tenant.id),
                "name": tenant.name,
                "subdomain": tenant.subdomain,
                "isActive": bool(tenant.is_active),
                "gatewayTenantId": str(settings.get("gateway_tenant_id") or ""),
            }
        )
    overview["saasTenants"] = saas_tenants
    return overview


@router.post("/admin/tenants")
async def create_gateway_tenant(
    data: GatewayTenantCreate,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    created = await _gateway_call(
        "POST",
        "/saas/v1/tenants",
        json_body={
            "name": data.name,
            "username": data.username,
            "password": data.password,
        },
    )
    gateway_tenant_id = str((created.get("tenant") or {}).get("tenantId") or "")
    if data.saas_tenant_id and gateway_tenant_id:
        tenant = await _tenant_row(db, data.saas_tenant_id)
        settings = _tenant_settings(tenant)
        settings["gateway_tenant_id"] = gateway_tenant_id
        plugins = settings.get("plugins")
        if not isinstance(plugins, list):
            plugins = []
        if "gateway" not in plugins:
            plugins.append("gateway")
        settings["plugins"] = plugins
        tenant.settings = json.dumps(settings, ensure_ascii=False)
        await db.commit()
    return created


@router.post("/admin/bind")
async def bind_gateway_tenant(
    data: GatewayBindRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_admin(current_user)
    tenant = await _tenant_row(db, data.saas_tenant_id)
    gateway_tenant_id = data.gateway_tenant_id.strip()
    if gateway_tenant_id:
        overview = await _gateway_call("GET", "/saas/v1/overview")
        known_ids = {str(item.get("id")) for item in overview.get("tenants", [])}
        if gateway_tenant_id not in known_ids:
            raise HTTPException(status_code=404, detail="网关租户不存在")

    settings = _tenant_settings(tenant)
    if gateway_tenant_id:
        settings["gateway_tenant_id"] = gateway_tenant_id
    else:
        settings.pop("gateway_tenant_id", None)
    plugins = settings.get("plugins")
    if not isinstance(plugins, list):
        plugins = []
    if gateway_tenant_id and "gateway" not in plugins:
        plugins.append("gateway")
    if not gateway_tenant_id:
        plugins = [item for item in plugins if item != "gateway"]
    settings["plugins"] = plugins
    tenant.settings = json.dumps(settings, ensure_ascii=False)
    await db.commit()
    return {"ok": True, "gatewayTenantId": gateway_tenant_id}


@router.post("/admin/tenants/{gateway_tenant_id}/recharge")
async def recharge_gateway_tenant(
    gateway_tenant_id: str,
    data: GatewayRechargeRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{gateway_tenant_id}/recharge",
        json_body={
            "amountFen": data.amount_fen,
            "description": data.description,
        },
    )


@router.post("/admin/tenants/{gateway_tenant_id}/status")
async def set_gateway_tenant_status(
    gateway_tenant_id: str,
    data: GatewayStatusRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{gateway_tenant_id}/status",
        json_body={"status": data.status},
    )


@router.post("/admin/tenants/{gateway_tenant_id}/voices")
async def add_gateway_voice(
    gateway_tenant_id: str,
    data: GatewayVoiceRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{gateway_tenant_id}/voices",
        json_body={"name": data.name, "speakerId": data.speaker_id},
    )


@router.put("/admin/prices/{service}")
async def update_gateway_price(
    service: str,
    data: GatewayPriceRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    if service not in {"asr", "tts", "tos"}:
        raise HTTPException(status_code=400, detail="不支持的计费服务")
    return await _gateway_call(
        "PUT",
        f"/saas/v1/prices/{service}",
        json_body={"unitPriceMicrofen": data.unit_price_microfen},
    )


@router.post("/admin/recharge-codes")
async def create_gateway_recharge_code(
    data: GatewayRechargeCodeRequest,
    current_user: dict = Depends(get_current_user),
):
    _require_admin(current_user)
    return await _gateway_call(
        "POST",
        "/saas/v1/recharge-codes",
        json_body={
            "amountFen": data.amount_fen,
            "tenantId": data.tenant_id or None,
        },
    )


@router.get("/tenant/summary")
async def tenant_gateway_summary(
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")
    tenant = await _tenant_row(db, tenant_id)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)
    return await _gateway_call(
        "GET",
        f"/saas/v1/tenants/{gateway_tenant_id}/dashboard",
    )


@router.post("/tenant/redeem")
async def redeem_tenant_recharge_code(
    request: Request,
    data: GatewayRedeemRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_tenant_admin(request)
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")
    tenant = await _tenant_row(db, tenant_id)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)
    return await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{gateway_tenant_id}/redeem",
        json_body={"code": data.code},
    )


@router.post("/tenant/recharge/wechat")
async def create_wechat_recharge(
    request: Request,
    data: GatewayWechatRechargeRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_tenant_admin(request)
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")

    tenant = await _tenant_row(db, tenant_id)
    cfg = await _gateway_wxpay_config(db)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)

    try:
        await _prepare_wechat_verifier(cfg)
    except Exception as exc:
        error_text = str(exc)
        if "平台证书" in error_text and "无可用的平台证书" in error_text:
            detail = (
                "微信支付验签配置不完整：该商户使用新版微信支付公钥，"
                "请在阿彭牛排后台补充微信支付公钥 PEM 和公钥 ID。"
            )
        else:
            detail = f"微信支付验签配置不可用：{error_text[:200]}"
        raise HTTPException(status_code=503, detail=detail) from exc

    created = await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{quote(gateway_tenant_id, safe='')}/payment-orders",
        json_body={
            "amountFen": data.amount_fen,
            "description": "AI 网关余额充值",
            "channel": "wechat_native",
        },
    )
    order = created.get("order") or {}
    out_trade_no = str(order.get("outTradeNo") or "")
    if not out_trade_no:
        raise HTTPException(status_code=502, detail="网关未返回充值订单号")

    expires_at = datetime.now(timezone(timedelta(hours=8))) + timedelta(minutes=30)
    from app.services.wxpay_service import close_wxpay_order, create_native_wxpay_order
    public_key_pem, public_key_id = _wechat_public_key_config(cfg)

    result: dict[str, Any] | None = None
    try:
        result = await create_native_wxpay_order(
            appid=_gateway_payment_appid(cfg),
            mchid=str(cfg.wxpay_mchid or ""),
            description="AI 网关余额充值",
            out_trade_no=out_trade_no,
            amount_total=data.amount_fen,
            notify_url=_wechat_notify_url(),
            serial_no=str(cfg.wxpay_serial_no or ""),
            private_key_pem=str(cfg.wxpay_key_pem or ""),
            time_expire=expires_at.isoformat(timespec="seconds"),
            platform_public_key_pem=public_key_pem,
            platform_public_key_id=public_key_id,
        )
        code_url = str(result.get("code_url") or "")
        qr_data_url = _wechat_qr_data_url(code_url)
    except Exception as exc:
        if result:
            try:
                await close_wxpay_order(
                    mchid=str(cfg.wxpay_mchid or ""),
                    out_trade_no=out_trade_no,
                    serial_no=str(cfg.wxpay_serial_no or ""),
                    private_key_pem=str(cfg.wxpay_key_pem or ""),
                )
            except Exception as close_exc:
                print(
                    "[gateway-wxpay] 关闭异常订单时出错 "
                    f"out_trade_no={out_trade_no}: {str(close_exc)[:200]}"
                )
        print(f"[gateway-wxpay] 下单失败 out_trade_no={out_trade_no}: {exc}")
        try:
            await _gateway_call(
                "POST",
                f"/saas/v1/payment-orders/{quote(out_trade_no, safe='')}/fail",
                json_body={"reason": f"WeChat Native order failed: {str(exc)[:150]}"},
            )
        except Exception as mark_exc:
            print(
                "[gateway-wxpay] 标记失败订单时出错 "
                f"out_trade_no={out_trade_no}: {str(mark_exc)[:200]}"
            )
        error_text = str(exc)
        if "权限未开通" in error_text or "产品权限" in error_text:
            detail = (
                f"微信支付暂不可用：{get_settings().gateway_recharge_payment_tenant_name}"
                "收款商户尚未开通 Native 支付，请先在微信支付商户平台的产品中心开通。"
            )
        else:
            detail = f"微信支付下单失败：{error_text[:200]}"
        raise HTTPException(
            status_code=502,
            detail=detail,
        ) from exc

    return {
        "ok": True,
        "out_trade_no": out_trade_no,
        "amount_fen": data.amount_fen,
        "code_url": code_url,
        "qr_data_url": qr_data_url,
        "expires_at": expires_at.isoformat(timespec="seconds"),
    }


@router.get("/tenant/recharge/wechat/{out_trade_no}")
async def get_wechat_recharge_status(
    out_trade_no: str,
    request: Request,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_tenant_admin(request)
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")

    tenant = await _tenant_row(db, tenant_id)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)
    order_payload = await _gateway_call(
        "GET",
        f"/saas/v1/payment-orders/{quote(out_trade_no, safe='')}",
    )
    order = order_payload.get("order") or {}
    if str(order.get("tenantId") or "") != gateway_tenant_id:
        raise HTTPException(status_code=404, detail="充值订单不存在")
    if order.get("status") == "credited":
        return {"ok": True, "status": "credited", "order": order}
    if order.get("status") != "pending":
        return {"ok": True, "status": order.get("status"), "order": order}

    cfg = await _gateway_wxpay_config(db, require_published=False)
    from app.services.wxpay_service import query_wxpay_order

    try:
        await _prepare_wechat_verifier(cfg)
        public_key_pem, public_key_id = _wechat_public_key_config(cfg)
        payment = await query_wxpay_order(
            mchid=str(cfg.wxpay_mchid or ""),
            out_trade_no=out_trade_no,
            serial_no=str(cfg.wxpay_serial_no or ""),
            private_key_pem=str(cfg.wxpay_key_pem or ""),
            api_v3_key=_gateway_payment_api_v3_key(cfg),
            platform_public_key_pem=public_key_pem,
            platform_public_key_id=public_key_id,
        )
    except Exception as exc:
        print(f"[gateway-wxpay] 查询失败 out_trade_no={out_trade_no}: {exc}")
        raise HTTPException(
            status_code=502,
            detail=f"微信支付状态查询失败：{str(exc)[:200]}",
        ) from exc

    trade_state = str(payment.get("trade_state") or "").upper()
    if trade_state == "SUCCESS":
        credited = await _credit_wechat_recharge(order, cfg, payment)
        return {"ok": True, "status": "credited", **(credited or {})}
    if trade_state in {"CLOSED", "REVOKED", "PAYERROR"}:
        failed = await _gateway_call(
            "POST",
            f"/saas/v1/payment-orders/{quote(out_trade_no, safe='')}/fail",
            json_body={"reason": f"WeChat trade state: {trade_state}"},
        )
        return {"ok": True, "status": "failed", "order": failed.get("order")}
    return {"ok": True, "status": "pending", "trade_state": trade_state}


@router.post("/tenant/recharge/wechat/notify")
async def wechat_recharge_notify(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    body_str = (await request.body()).decode("utf-8")
    if not body_str:
        return {"code": "SUCCESS", "message": "OK"}
    try:
        body_json = json.loads(body_str)
    except json.JSONDecodeError:
        return JSONResponse(
            status_code=400,
            content={"code": "FAIL", "message": "Invalid notification"},
        )
    if not (body_json.get("resource") or {}).get("ciphertext"):
        return {"code": "SUCCESS", "message": "OK"}

    from app.services.wxpay_service import verify_notify_signature

    try:
        cfg = await _gateway_wxpay_config(db, require_published=False)
        await _prepare_wechat_verifier(cfg)
        public_key_pem, public_key_id = _wechat_public_key_config(cfg)
        payment = verify_notify_signature(
            body_str=body_str,
            signature=request.headers.get("Wechatpay-Signature", ""),
            serial_no=request.headers.get("Wechatpay-Serial", ""),
            api_v3_key=_gateway_payment_api_v3_key(cfg),
            timestamp=request.headers.get("Wechatpay-Timestamp", ""),
            nonce=request.headers.get("Wechatpay-Nonce", ""),
            public_key_pem=public_key_pem,
            public_key_id=public_key_id,
        )
    except Exception as exc:
        print(f"[gateway-wxpay] 无法验证微信支付回调: {str(exc)[:200]}")
        return JSONResponse(
            status_code=400,
            content={"code": "FAIL", "message": "Signature verification failed"},
        )

    out_trade_no = str(payment.get("out_trade_no") or "").strip()
    if not out_trade_no:
        return {"code": "SUCCESS", "message": "OK"}

    try:
        order_payload = await _gateway_call(
            "GET",
            f"/saas/v1/payment-orders/{quote(out_trade_no, safe='')}",
        )
    except HTTPException as exc:
        if exc.status_code == 404:
            print(f"[gateway-wxpay] 忽略未知充值订单 out_trade_no={out_trade_no}")
            return {"code": "SUCCESS", "message": "OK"}
        print(f"[gateway-wxpay] 回调读取订单失败 out_trade_no={out_trade_no}: {exc.detail}")
        return JSONResponse(
            status_code=500,
            content={"code": "FAIL", "message": "Gateway unavailable"},
        )
    order = order_payload.get("order") or {}
    if not order:
        print(f"[gateway-wxpay] 忽略未知充值订单 out_trade_no={out_trade_no}")
        return {"code": "SUCCESS", "message": "OK"}

    try:
        await _credit_wechat_recharge(order, cfg, payment)
    except HTTPException as exc:
        print(f"[gateway-wxpay] 回调入账失败 out_trade_no={out_trade_no}: {exc.detail}")
        return JSONResponse(
            status_code=500 if exc.status_code >= 500 else 400,
            content={"code": "FAIL", "message": str(exc.detail)},
        )

    print(f"[gateway-wxpay] 充值成功 out_trade_no={out_trade_no}")
    return {"code": "SUCCESS", "message": "OK"}


@router.post("/tenant/tokens")
async def create_tenant_gateway_token(
    request: Request,
    data: GatewayTokenRequest,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_tenant_admin(request)
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")
    tenant = await _tenant_row(db, tenant_id)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)
    return await _gateway_call(
        "POST",
        f"/saas/v1/tenants/{gateway_tenant_id}/tokens",
        json_body={"name": data.name},
    )


@router.delete("/tenant/tokens/{token_id}")
async def disable_tenant_gateway_token(
    request: Request,
    token_id: str,
    current_user: dict = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    _require_tenant_admin(request)
    tenant_id = str(current_user.get("tenant_id") or "")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="当前账号不属于商户")
    tenant = await _tenant_row(db, tenant_id)
    gateway_tenant_id = await _tenant_gateway_id(db, tenant)
    return await _gateway_call(
        "DELETE",
        f"/saas/v1/tenants/{gateway_tenant_id}/tokens/{token_id}",
    )
