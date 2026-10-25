"""
创意广告精选 — FastAPI 后端入口
端口 4000，独立于 reedbookAPI（端口 3000/5500）
"""
from contextlib import asynccontextmanager
from pathlib import Path
from datetime import datetime, timezone
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import get_settings
from app.core.security import decode_access_token, hash_password
from app.core.database import engine, Base, AsyncSessionLocal
from app.models.all import User
from app.api import auth, templates, generation, tokens, dashboard, admin, workshop, miniapp, apps, studio, tenant, kuaishou, digital_human, xiawazhibo, corporate, gateway
from app.api.apps import intelligence_router
from app.services.intelligence_sync import (
    start_intelligence_scheduler,
    stop_intelligence_scheduler,
)

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
TEMPLATES_DIR = FRONTEND_DIR / "templates"

settings = get_settings()

def svg_icon(name: str) -> str:
    """Inline SVG icons for Jinja2 templates."""
    icons = {
        "image": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>',
        "qrcode": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h6v6H3z"/><path d="M15 3h6v6h-6z"/><path d="M3 15h6v6H3z"/><path d="M15 15h3v3h-3z"/><path d="M18 15h3v3h-3z"/><path d="M15 18h3v3h-3z"/><path d="M18 18h3v3h-3z"/></svg>',
        "upload": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
        "download": '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    }
    return icons.get(name, f"<!-- svg_icon '{name}' not found -->")

templates_engine = Jinja2Templates(directory=str(TEMPLATES_DIR))
templates_engine.env.globals["svg_icon"] = svg_icon


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("🚀 创意广告精选 API 启动中...")
    # ── 1. 自动建表 ──
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    print("   ✅ 数据库表已就绪")

    # ── 1.1 初始化平台级 AI 网关支付配置 ──
    async with AsyncSessionLocal() as session:
        await gateway.ensure_gateway_payment_config(session)
    print("   ✅ AI 网关支付配置已就绪")

    # ── 2. 自动创建 admin 用户（如果不存在）──
    async with AsyncSessionLocal() as session:
        from sqlalchemy import select
        result = await session.execute(select(User).where(User.username == "admin"))
        admin_user = result.scalar_one_or_none()
        if not admin_user:
            import uuid
            admin = User(
                id=uuid.uuid4(),
                username="admin",
                email="admin@ad-creative.local",
                password_hash=hash_password("admin888"),
                role="admin",
            )
            session.add(admin)
            await session.commit()
            print("   ✅ 已创建 admin 用户 (admin / admin888, Token: 9999)")
        else:
            print(f"   ✅ admin 用户已存在")

    # ── 3. 自动创建行业分类（如果不存在）──
    async with AsyncSessionLocal() as session:
        from app.models.all import Industry
        result = await session.execute(select(Industry).limit(1))
        if not result.scalar_one_or_none():
            industries = [
                Industry(id="a001", name="餐饮", icon="🍽️", sort_order=1),
                Industry(id="a002", name="美业", icon="💄", sort_order=2),
                Industry(id="a003", name="零售", icon="🏪", sort_order=3),
                Industry(id="a004", name="电商", icon="🛒", sort_order=4),
                Industry(id="a005", name="教育", icon="📚", sort_order=5),
                Industry(id="a006", name="医疗", icon="🏥", sort_order=6),
                Industry(id="a007", name="地产", icon="🏠", sort_order=7),
                Industry(id="a008", name="金融", icon="💰", sort_order=8),
                Industry(id="a009", name="旅游", icon="✈️", sort_order=9),
                Industry(id="a010", name="健身", icon="🏋️", sort_order=10),
            ]
            session.add_all(industries)
            await session.commit()
            print("   ✅ 已创建 10 个行业分类")
        else:
            print(f"   ✅ 行业分类已存在")

    # ── 4. 自动同步内置角色到 roles 表 ──
    async with AsyncSessionLocal() as session:
        from app.models.all import RoleModel
        from sqlalchemy import select
        result = await session.execute(select(RoleModel).limit(1))
        if not result.scalar_one_or_none():
            import json
            builtin_roles = [
                RoleModel(name="admin", description="超级管理员 — 所有权限", is_builtin=True,
                          permissions=json.dumps(["templates.view", "templates.create", "templates.edit", "templates.delete",
                                       "generation.run", "generation.view", "generation.delete",
                                       "users.view", "users.create", "users.edit", "users.delete",
                                       "roles.view", "roles.create", "roles.edit", "roles.delete",
                                       "tenants.view", "tenants.create", "tenants.edit", "tenants.delete",
                                       "juguang.view", "juguang.create", "juguang.edit", "juguang.delete",
                                       "kuaishou-card.view",
                                       "settings.view", "settings.edit",
                                       "workshop.view", "workshop.create", "workshop.edit", "workshop.delete"])),
                RoleModel(name="editor", description="编辑 — 内容创作与模板管理", is_builtin=True,
                          permissions=json.dumps(["templates.view", "templates.create", "templates.edit",
                                       "generation.run", "generation.view", "generation.delete",
                                       "workshop.view", "workshop.create", "workshop.edit",
                                       "juguang.view", "juguang.create", "juguang.edit",
                                       "kuaishou-card.view"])),
                RoleModel(name="user", description="普通用户 — 内容生成与查看", is_builtin=True,
                          permissions=json.dumps(["templates.view", "generation.run", "generation.view",
                                       "workshop.view", "workshop.create"])),
                RoleModel(name="viewer", description="访客 — 仅查看", is_builtin=True,
                          permissions=json.dumps(["templates.view", "generation.view", "workshop.view"])),
            ]
            session.add_all(builtin_roles)
            await session.commit()
            print("   ✅ 内置角色已同步到 roles 表")
        else:
            print("   ✅ 内置角色已存在")

    # ── 5. 自动创建示例商户（如果不存在）──
    async with AsyncSessionLocal() as session:
        from app.models.all import Tenant
        from sqlalchemy import select
        result = await session.execute(select(Tenant).limit(1))
        if not result.scalar_one_or_none():
            import uuid
            demo_tenant = Tenant(
                id=str(uuid.uuid4()),
                name="演示商户",
                subdomain="demo",
                logo_url="",
                contact_name="管理员",
                contact_email="admin@demo.local",
                is_active=True,
            )
            session.add(demo_tenant)
            await session.commit()
            print("   ✅ 示例商户已创建")
        else:
            print("   ✅ 商户数据已存在")

    await start_intelligence_scheduler()

    print("🚀 服务启动 → http://0.0.0.0:4000")
    print("   文档 → http://0.0.0.0:4000/docs")
    try:
        yield
    finally:
        await stop_intelligence_scheduler()


app = FastAPI(title="创意广告精选 API", lifespan=lifespan)

# Mount static files (CSS, JS, images)
STATIC_DIR = FRONTEND_DIR / "static"
ROOT_STATIC = BASE_DIR / "static"
# Mount root static/ first, fallback to frontend/static/ if root doesn't exist
if ROOT_STATIC.exists():
    app.mount("/static", StaticFiles(directory=str(ROOT_STATIC)), name="static")
elif STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 静态文件
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
app.mount("/outputs", StaticFiles(directory=settings.outputs_dir), name="outputs")
app.mount("/landing-images", StaticFiles(directory=str(BASE_DIR / "landing-images")), name="landing-images")
app.mount("/data/hyperframes/static", StaticFiles(directory=str(BASE_DIR / "data" / "hyperframes" / "static")), name="hyperframes-static")
app.mount("/data/openmontage/static", StaticFiles(directory=str(BASE_DIR / "data" / "openmontage" / "static")), name="openmontage-static")
app.mount("/corporate-site", StaticFiles(directory=str(BASE_DIR / "corporate-site"), html=True), name="corporate-site")

# ── JWT 校验中间件 ──
AUTH_WHITELIST = {
    "/login",
    "/api/auth/login",
    "/api/health", "/docs", "/openapi.json", "/redoc",
    "/api/miniapp/login",
    "/api/miniapp/wxlogin",
    "/api/miniapp/products",
    "/api/apps/wenangou/skills",
    "/api/miniapp/industries",
    "/api/miniapp/config",
    "/api/apps/gateway/tenant/recharge/wechat/notify",
    "/miniapp", "/miniapp-web.html",
    "/changelog",
    "/tenant/login", "/tenant/dashboard", "/api/corporate/content",
}
AUTH_WHITELIST_PREFIXES = {
    "/api/apps/studio/",
    "/studio/",
    "/api/apps/wenangou/public/",
    "/apps/wenangou/detail/",
    "/api/apps/intelligence/",
    "/api/apps/xiawazhibo/",
    "/api/miniapp/",
    "/api/tenant/",
    "/r/",
}
STATIC_PREFIXES = {"/static/", "/outputs/", "/landing-images/", "/data/", "/corporate-site/"}

class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path in AUTH_WHITELIST or any(path.startswith(p) for p in AUTH_WHITELIST_PREFIXES) or any(path.startswith(p) for p in STATIC_PREFIXES):
            return await call_next(request)
        # 尝试 admin 认证（auth_token）
        token = request.cookies.get("auth_token") or request.headers.get("Authorization", "").replace("Bearer ", "")
        if token:
            payload = decode_access_token(token)
            if payload:
                request.state.user_id = payload.get("sub")
                request.state.username = payload.get("username")
                return await call_next(request)
        # 对于 /apps/* 或 /tenant/apps/* 路径，降级尝试 tenant_token
        is_tenant_route = (
            path.startswith("/apps/")
            or path == "/apps"
            or path.startswith("/api/apps/")
            or path == "/tenant/apps"
            or path.startswith("/tenant/apps/")
            or path == "/tenant/wxpay-config"
            or path.startswith("/api/corporate")
        )
        if is_tenant_route:
            tenant_token = request.cookies.get("tenant_token")
            if tenant_token:
                payload = decode_access_token(tenant_token)
                if payload and payload.get("tenant_id"):
                    request.state.is_tenant = True
                    request.state.tenant_id = payload.get("tenant_id")
                    request.state.tenant_name = payload.get("tenant_name", "")
                    request.state.user_id = payload.get("sub")
                    request.state.username = payload.get("username")
                    return await call_next(request)
            # 无有效 tenant_token 也渲染页面（显示登录提示），避免跳转总后台 /login
            return await call_next(request)
        if path.startswith("/api/"):
            return JSONResponse(status_code=401, content={"detail": "未登录"})
        return RedirectResponse(url="/login")

app.add_middleware(AuthMiddleware)

# ── 前端页面 ──
@app.get("/")
async def root(request: Request):
    user_id = getattr(request.state, "user_id", None)
    return templates_engine.TemplateResponse(request, "index.html", {"request": request, "user_id": user_id})

@app.get("/login")
async def login_page(request: Request):
    return templates_engine.TemplateResponse(request, "login.html", {"request": request, "user_id": None})

@app.get("/register")
async def register_page(request: Request):
    # 注册功能已关闭，重定向到登录页
    return RedirectResponse(url="/login", status_code=302)

@app.get("/dashboard")
async def dashboard_page(request: Request):
    return templates_engine.TemplateResponse(request, "dashboard.html", {"request": request, "user_id": getattr(request.state, "user_id", None)})

@app.get("/templates")
async def templates_page(request: Request):
    return templates_engine.TemplateResponse(request, "templates.html", {"request": request, "user_id": getattr(request.state, "user_id", None)})

@app.get("/studio/generate")
async def studio_generator_page(request: Request):
    return templates_engine.TemplateResponse(request, "studio_generator.html", {"request": request})

# ── 微信缓存穿透 — 跳转到橙子建站页面，带时间戳防止 X5 显示缓存 ──
WEIXIN_REDIRECT_MAP = {
    "chl": "https://www.chengzijianzhan.com/tetris/page/7640417517148864538/",
}

@app.get("/r/{page_id}")
async def weixin_redirect(page_id: str):
    from datetime import datetime
    target = WEIXIN_REDIRECT_MAP.get(page_id)
    if not target:
        return JSONResponse(status_code=404, content={"detail": "页面不存在"})
    ts = int(datetime.now().timestamp() * 1000)
    url = f"{target}?t={ts}&from=secchuangyun"
    resp = RedirectResponse(url=url, status_code=302)
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, proxy-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

# ── 管理后台页面 ──
@app.get("/admin")
async def admin_index(request: Request):
    return templates_engine.TemplateResponse(request, "admin/index.html", {"request": request})

@app.get("/admin/users")
async def admin_users(request: Request):
    return templates_engine.TemplateResponse(request, "admin/users.html", {"request": request})

@app.get("/admin/roles")
async def admin_roles(request: Request):
    return templates_engine.TemplateResponse(request, "admin/roles.html", {"request": request})

@app.get("/admin/tenants")
async def admin_tenants(request: Request):
    return templates_engine.TemplateResponse(request, "admin/tenants.html", {"request": request})

@app.get("/admin/settings")
async def admin_settings(request: Request):
    return templates_engine.TemplateResponse(request, "admin/settings.html", {"request": request})

@app.get("/admin/oss")
async def admin_oss(request: Request):
    return templates_engine.TemplateResponse(request, "admin/oss_replace.html", {"request": request})

# ── 创意工坊页面 ──
@app.get("/workshop/templates")
async def workshop_templates(request: Request):
    return templates_engine.TemplateResponse(request, "workshop/templates.html", {"request": request})

@app.get("/workshop/agents")
async def workshop_agents(request: Request):
    return templates_engine.TemplateResponse(request, "workshop/agents.html", {"request": request})

@app.get("/workshop/agents/import")
async def workshop_agents_import(request: Request):
    return templates_engine.TemplateResponse(request, "workshop/agents-import.html", {"request": request})

@app.get("/workshop/agents/{agent_id}")
async def workshop_agents_detail(request: Request, agent_id: str):
    return templates_engine.TemplateResponse(request, "workshop/agents-detail.html", {"request": request})

@app.get("/workshop/skills/import")
async def workshop_skills_import(request: Request):
    return templates_engine.TemplateResponse(request, "workshop/skills-import.html", {"request": request})

@app.get("/workshop/prompts/import")
async def workshop_prompts_import(request: Request):
    return templates_engine.TemplateResponse(request, "workshop/prompts-import.html", {"request": request})

@app.get("/workshop/skills/{skill_id}")
async def workshop_skills_detail(request: Request, skill_id: str):
    return templates_engine.TemplateResponse(request, "workshop/skills-detail.html", {"request": request})

# ── 应用页面 ──
@app.get("/apps")
async def apps_index(request: Request):
    tenant_plugins = []
    is_tenant = getattr(request.state, "is_tenant", False)
    if is_tenant:
        tenant_id = getattr(request.state, "tenant_id", None)
        if tenant_id:
            from app.models.all import Tenant
            from sqlalchemy import select
            async with AsyncSessionLocal() as db:
                result = await db.execute(select(Tenant).where(Tenant.id == tenant_id))
                tenant = result.scalar_one_or_none()
                if tenant and tenant.settings:
                    import json
                    try:
                        settings = json.loads(tenant.settings) if isinstance(tenant.settings, str) else tenant.settings
                        tenant_plugins = settings.get("plugins", [])
                    except Exception:
                        tenant_plugins = []
    return templates_engine.TemplateResponse(request, "apps/index.html", {
        "request": request,
        "user_id": getattr(request.state, "user_id", None),
        "is_tenant": is_tenant,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "tenant_plugins": tenant_plugins,
    })

@app.get("/tenant/apps")
async def tenant_apps_index(request: Request):
    return templates_engine.TemplateResponse(request, "tenant/apps.html", {
        "request": request,
    })

@app.get("/apps/intelligence")
async def apps_intelligence(request: Request):
    return templates_engine.TemplateResponse(request, "apps/intelligence.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/intelligence/article")
async def apps_intelligence_article(request: Request, cat: str = "hot", idx: int = 0):
    return templates_engine.TemplateResponse(request, "apps/intelligence_article.html", {"request": request, "cat": cat, "idx": idx, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/wenangou")
async def apps_wenangou(request: Request):
    return templates_engine.TemplateResponse(request, "apps/wenangou.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/wenangou/detail/{record_id}")
async def apps_wenangou_detail(request: Request, record_id: str):
    from app.models.all import WenangouRecord
    from sqlalchemy import select
    import uuid, json
    type_labels = {
        "knowledge": {"name": "知识分享", "icon": "📖"},
        "interact": {"name": "两人互动", "icon": "🎭"},
        "scenario": {"name": "剧情演绎", "icon": "🎬"},
    }
    try:
        rid = uuid.UUID(record_id)
    except Exception:
        return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
            "request": request, "record": None, "type_labels": type_labels,
            "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None),
        })
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(WenangouRecord).where(WenangouRecord.id == rid))
        r = result.scalar_one_or_none()
        if not r:
            return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
                "request": request, "record": None, "type_labels": type_labels,
                "user_id": getattr(request.state, "user_id", None),
            })
        try:
            types_list = json.loads(r.types) if isinstance(r.types, str) else r.types
        except Exception:
            types_list = []
        try:
            content_dict = json.loads(r.content) if isinstance(r.content, str) else r.content
        except Exception:
            content_dict = {}
        # 从 content 中提取第一个 # 标题
        title = r.prompt.strip().split('\n')[0] if r.prompt else "未命名"
        if content_dict:
            for k, v in content_dict.items():
                if isinstance(v, str):
                    lines = v.split('\n')
                    for line in lines:
                        stripped = line.strip()
                        if stripped.startswith('# ') and not stripped.startswith('## '):
                            title = stripped[2:].strip()
                            break
                if title != r.prompt.strip().split('\n')[0] if r.prompt else "未命名":
                    break
        # 合并所有类型的内容为一个完整文本（用于TTS）
        full_text_parts = []
        for k, v in content_dict.items():
            if isinstance(v, str) and v.strip():
                full_text_parts.append(v.strip())
        full_text = '\n\n'.join(full_text_parts)

        record = {
            "id": str(r.id),
            "prompt": r.prompt,
            "title": title,
            "skill": r.skill,
            "model_used": r.model_used,
            "types": types_list,
            "content": content_dict,
            "full_text": full_text,
            "created_at": r.created_at.isoformat() if r.created_at else "",
        }
    return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
        "request": request, "record": record, "type_labels": type_labels,
        "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None),
    })

@app.get("/apps/juguang")
async def apps_juguang(request: Request):
    return templates_engine.TemplateResponse(request, "apps/juguang.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/juguang/accounts")
async def apps_juguang_accounts(request: Request):
    return templates_engine.TemplateResponse(request, "apps/juguang/accounts.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/kuaishou-card")
async def apps_kuaishou_card(request: Request):
    return templates_engine.TemplateResponse(request, "apps/kuaishou-card.html", {
        "request": request,
        "user_role": "admin",
        "user_id": getattr(request.state, "user_id", None),
        "is_tenant": getattr(request.state, "is_tenant", False),
        "tenant_id": getattr(request.state, "tenant_id", None),
    })

@app.get("/apps/oss-replace")
async def apps_oss_replace(request: Request):
    request.state.user = {"role": "admin"}
    return templates_engine.TemplateResponse(request, "apps/oss_replace.html", {
        "request": request,
        "user_role": "admin",
        "base_template": "_base.html",
        "user_id": getattr(request.state, "user_id", None),
        "is_tenant": getattr(request.state, "is_tenant", False),
        "tenant_id": getattr(request.state, "tenant_id", None),
    })

@app.get("/apps/diy-miniapp")
async def apps_diy_miniapp(request: Request):
    return templates_engine.TemplateResponse(request, "apps/diy-miniapp.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/qiji-fighter")
async def apps_qiji_fighter(request: Request):
    """全民奇奇战机游戏运营后台入口"""
    return templates_engine.TemplateResponse(request, "apps/qiji-fighter.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/xiawazhibo")
async def apps_xiawazhibo(request: Request):
    return templates_engine.TemplateResponse(request, "apps/xiawazhibo.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/gateway")
async def apps_gateway(request: Request):
    return templates_engine.TemplateResponse(request, "apps/gateway.html", {
        "request": request,
        "is_tenant": False,
        "user_id": getattr(request.state, "user_id", None),
    })

@app.get("/tenant/apps/xiawazhibo")
async def tenant_apps_xiawazhibo(request: Request):
    return templates_engine.TemplateResponse(request, "apps/xiawazhibo.html", {"request": request, "tenant_base": "tenant/_base.html", "user_id": getattr(request.state, "user_id", None), "is_tenant": True, "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/xiawazhibo/admin")
async def apps_xiawazhibo_admin(request: Request):
    """菜谱小程序后台管理 — 视频/分类/用户管理"""
    return templates_engine.TemplateResponse(request, "apps/xiawazhibo_admin.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/tenant/apps/xiawazhibo/admin")
async def tenant_apps_xiawazhibo_admin(request: Request):
    """商户后台 — 菜谱小程序管理"""
    return templates_engine.TemplateResponse(request, "apps/xiawazhibo_admin.html", {"request": request, "tenant_base": "tenant/_base.html", "user_id": getattr(request.state, "user_id", None), "is_tenant": True, "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/studio")
async def apps_studio(request: Request):
    return templates_engine.TemplateResponse(request, "apps/studio.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

@app.get("/apps/studio/templates")
async def apps_studio_templates(request: Request):
    return templates_engine.TemplateResponse(request, "apps/studio_templates.html", {"request": request, "user_id": getattr(request.state, "user_id", None), "is_tenant": getattr(request.state, "is_tenant", False), "tenant_id": getattr(request.state, "tenant_id", None)})

# ── 变更日志 ──
@app.get("/changelog")
async def changelog(request: Request):
    entries = [
        {
            "date": "2026-05-11",
            "day_label": "今日更新",
            "entries": [
                {
                    "tag": "update",
                    "tag_label": "优化",
                    "title": "应用中心全面升级",
                    "description": "卡片顺序重新编排，新增情报局、文案狗、声音克隆、数字人四个应用入口；新增微信/小红书/抖音三个团购小程序卡片；优化视觉分类与图标配色。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "数字人 — 视频创意编排",
                    "description": "原创意工作室升级为数字人模块：支持数字人形象/角色资产库管理、多镜头分镜编辑器、风格模板画廊一键复用。"
                },
            ],
        },
        {
            "date": "2026-05-01",
            "day_label": "正式上线",
            "entries": [
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "秒创云 1.0 正式版发布",
                    "description": "AI内容创作平台正式上线，支持文案+海报+短视频三件套一键生成。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "微信小程序前端上线",
                    "description": "消费者端微信小程序接入，支持在线查看/体验AI生成内容。"
                },
                {
                    "tag": "update",
                    "tag_label": "优化",
                    "title": "聚光投放：批量创建 + 账号采集",
                    "description": "小红书聚光投放计划批量创建，支持Playwright自动采集Cookie与账号管理。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "管理后台：用户 + 数据概览",
                    "description": "用户列表管理、平台数据概览看板，支持多维度筛选与统计。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "角色权限系统",
                    "description": "自定义角色 + 功能权限勾选，支持细粒度访问控制。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "SaaS 商户管理",
                    "description": "独立商户后台，多租户支持，每个商户拥有独立的数据与配置空间。"
                },
                {
                    "tag": "update",
                    "tag_label": "优化",
                    "title": "全新 UI 界面",
                    "description": "基于 Tailwind 重构前端样式，更新图标系统，优化导航与卡片交互体验。"
                },
            ],
        },
        {
            "date": "2026-04-03",
            "day_label": "内测首发",
            "entries": [
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "初始版本发布",
                    "description": "秒创云 Beta 内测版本首次上线，开放核心功能体验。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "用户注册/登录系统",
                    "description": "基于 JWT 的用户认证系统，支持注册、登录、Token 刷新。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "模板管理 & AI 生成",
                    "description": "模板 CRUD 管理，集成 AI 生成引擎，支持文案/海报/短视频模板。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "内容生成（单篇 / 批量）",
                    "description": "支持单篇生成和批量生成两种模式，覆盖多种内容类型。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "行业分类管理",
                    "description": "支持自定义行业分类，按行业维度组织和管理内容模板。"
                },
                {
                    "tag": "new",
                    "tag_label": "新功能",
                    "title": "聚光投放计划管理",
                    "description": "小红书聚光投放计划的管理与状态跟踪。"
                },
            ],
        },
    ]
    return templates_engine.TemplateResponse(request, "changelog.html", {"request": request, "changelog_entries": entries})

# ── 迷你创客（消费者前端）──
@app.get("/miniapp")
async def miniapp_web(request: Request):
    return FileResponse(FRONTEND_DIR / "miniapp-web.html")

@app.get("/{page}.html")
async def page(request: Request, page: str):
    fp = TEMPLATES_DIR / f"{page}.html"
    if fp.exists():
        user_id = getattr(request.state, "user_id", None)
        return templates_engine.TemplateResponse(request, f"{page}.html", {"request": request, "user_id": user_id})
    static_fp = FRONTEND_DIR / f"{page}.html"
    if static_fp.exists():
        return FileResponse(static_fp)
    return templates_engine.TemplateResponse(request, "index.html", {"request": request, "user_id": getattr(request.state, "user_id", None)})


# ── 商户后台 ──
@app.get("/tenant/login")
async def tenant_login_page(request: Request, tenant_id: str = None):
    """商户登录页，支持：
    - tenant_id 查询参数（如 ?tenant_id=xxx）
    - 子域名自动识别（如 niuniu.xhscdn.cn/tenant/login）
    """
    brand = {}
    resolved_tenant_id = tenant_id or ""

    # ── 方案A: 从 Host 头解析子域名 ──
    if not tenant_id:
        host = request.headers.get("host", "").lower()
        import re
        m = re.match(r'^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.xhscdn\.cn', host)
        if m and m.group(1) != 'www':
            subdomain = m.group(1)
            try:
                from app.models.all import Tenant
                from app.core.database import get_db
                import json
                from sqlalchemy import select
                async for db in get_db():
                    row = await db.execute(select(Tenant).where(Tenant.subdomain == subdomain))
                    t = row.scalar_one_or_none()
                    if t:
                        resolved_tenant_id = str(t.id)
                        settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})
                        brand = {
                            "logo_url": settings.get("logo_url", "") or "",
                            "brand_name": settings.get("brand_name", "") or "",
                        }
            except Exception:
                brand = {}

    # ── 方案B: tenant_id 查询参数（兼容旧链接） ──
    if not brand and tenant_id:
        try:
            from uuid import UUID
            from app.models.all import Tenant
            from app.core.database import get_db
            import json
            from sqlalchemy import select
            async for db in get_db():
                row = await db.execute(select(Tenant).where(Tenant.id == UUID(tenant_id)))
                t = row.scalar_one_or_none()
                if t:
                    settings = json.loads(t.settings) if isinstance(t.settings, str) else (t.settings or {})
                    brand = {
                        "logo_url": settings.get("logo_url", "") or "",
                        "brand_name": settings.get("brand_name", "") or "",
                    }
        except Exception:
            brand = {}

    return templates_engine.TemplateResponse(request, "tenant/login.html", {
        "request": request,
        "brand": brand,
        "tenant_id": resolved_tenant_id,
    })

async def _resolve_tenant_dashboard_type(request: Request) -> str:
    """Resolve which tenant console to render.

    Explicit settings.dashboard_type wins. Existing tenants without that field
    are classified by plugin so the car-wash console keeps its old behavior.
    """
    from urllib.parse import unquote
    import json
    from sqlalchemy import select
    from app.models.all import Tenant

    token = request.cookies.get("tenant_token", "")
    if token:
        token = unquote(token)
    payload = decode_access_token(token) if token else None
    tenant_id = payload.get("tenant_id") if payload else None

    host = request.headers.get("host", "").split(":")[0].lower()
    host_parts = host.split(".")
    subdomain = None
    if len(host_parts) >= 3 and ".".join(host_parts[-2:]) == "xhscdn.cn":
        subdomain = host_parts[0]

    try:
        async with AsyncSessionLocal() as db:
            if tenant_id:
                from uuid import UUID
                tenant = (await db.execute(
                    select(Tenant).where(Tenant.id == UUID(str(tenant_id)))
                )).scalar_one_or_none()
            elif subdomain:
                tenant = (await db.execute(
                    select(Tenant).where(Tenant.subdomain == subdomain)
                )).scalar_one_or_none()
            else:
                tenant = None

            if not tenant:
                return "carwash"

            settings = json.loads(tenant.settings) if isinstance(tenant.settings, str) else (tenant.settings or {})
            explicit_type = str(settings.get("dashboard_type") or "").strip().lower()
            if explicit_type in ("carwash", "caipu"):
                return explicit_type

            plugins = settings.get("plugins") or []
            return "caipu" if "xiawazhibo" in plugins else "carwash"
    except Exception:
        return "carwash"


@app.get("/tenant/dashboard")
async def tenant_dashboard_page(request: Request):
    dashboard_type = await _resolve_tenant_dashboard_type(request)
    template = (
        "tenant/dashboard_caipu.html"
        if dashboard_type == "caipu"
        else "tenant/dashboard_carwash.html"
    )
    return templates_engine.TemplateResponse(request, template, {"request": request})

@app.get("/tenant/apps/tea-society")
async def tenant_tea_society(request: Request):
    """租户应用中心中的茶文化学会站点入口。"""
    return RedirectResponse(url="/corporate-site/#/", status_code=307)

@app.get("/apps/tea-society")
async def admin_tea_society(request: Request):
    """总后台的企业官网插件预览入口。"""
    return RedirectResponse(url="/corporate-site/#/", status_code=307)


app.include_router(auth.router)
app.include_router(templates.router)
app.include_router(generation.router)
app.include_router(tokens.router)
app.include_router(dashboard.router)
app.include_router(admin.router)
app.include_router(workshop.router)
app.include_router(miniapp.router)
app.include_router(apps.router)
app.include_router(xiawazhibo.router)
app.include_router(intelligence_router)
app.include_router(apps.wenangou_router)
app.include_router(studio.router)
app.include_router(tenant.router)
app.include_router(kuaishou.router)
app.include_router(digital_human.router)
app.include_router(corporate.router)
app.include_router(gateway.router)

# ── 商户后台 — 应用中心页面 ──
@app.get("/tenant/apps/intelligence")
async def tenant_apps_intelligence(request: Request):
    return templates_engine.TemplateResponse(request, "apps/intelligence.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/tenant/apps/wenangou")
async def tenant_apps_wenangou(request: Request):
    return templates_engine.TemplateResponse(request, "apps/wenangou.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/tenant/apps/gateway")
async def tenant_apps_gateway(request: Request):
    return templates_engine.TemplateResponse(request, "apps/gateway.html", {
        "request": request,
        "is_tenant": True,
        "tenant_base": "tenant/_base.html",
        "active_section": "apps",
    })

@app.get("/tenant/apps/wenangou/detail/{record_id}")
async def tenant_apps_wenangou_detail(request: Request, record_id: str):
    from app.models.all import WenangouRecord
    from sqlalchemy import select
    import uuid, json
    type_labels = {
        "knowledge": {"name": "知识分享", "icon": "📖"},
        "life": {"name": "生活随笔", "icon": "📝"},
        "business": {"name": "营销推广", "icon": "💼"},
        "tech": {"name": "技术科普", "icon": "💻"},
        "general": {"name": "通用", "icon": "📄"},
    }
    try:
        rid = uuid.UUID(record_id)
    except Exception:
        return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
            "request": request, "record": None, "type_labels": type_labels,
            "active_section": "apps",
            "tenant_base": "tenant/_base.html",
        })
    try:
        from app.core.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(WenangouRecord).where(WenangouRecord.id == rid)
            )
            r = result.scalar_one_or_none()
            if not r:
                return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
                    "request": request, "record": None, "type_labels": type_labels,
                    "active_section": "apps",
                    "tenant_base": "tenant/_base.html",
                })
            # 解析 JSON 字段
            try:
                types_list = json.loads(r.types) if isinstance(r.types, str) else r.types
            except Exception:
                types_list = []
            try:
                content_dict = json.loads(r.content) if isinstance(r.content, str) else r.content
            except Exception:
                content_dict = {}
            # 从 content 中提取第一个 # 标题
            title = r.prompt.strip().split('\n')[0] if r.prompt else "未命名"
            if content_dict:
                for k, v in content_dict.items():
                    if isinstance(v, str):
                        lines = v.split('\n')
                        for line in lines:
                            stripped = line.strip()
                            if stripped.startswith('# ') and not stripped.startswith('## '):
                                title = stripped[2:].strip()
                                break
                    if title != (r.prompt.strip().split('\n')[0] if r.prompt else "未命名"):
                        break
            # 合并所有类型的内容为完整文本（用于TTS）
            full_text_parts = []
            for k, v in content_dict.items():
                if isinstance(v, str) and v.strip():
                    full_text_parts.append(v.strip())
            full_text = '\n\n'.join(full_text_parts)

            record = {
                "id": str(r.id),
                "prompt": r.prompt,
                "title": title,
                "skill": r.skill,
                "model_used": r.model_used,
                "types": types_list,
                "content": content_dict,
                "full_text": full_text,
                "created_at": r.created_at.isoformat() if r.created_at else "",
            }
            return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
                "request": request, "record": record, "type_labels": type_labels,
                "active_section": "apps",
                "tenant_base": "tenant/_base.html",
            })
    except Exception:
        return templates_engine.TemplateResponse(request, "apps/wenangou_detail.html", {
            "request": request, "record": None, "type_labels": type_labels,
            "active_section": "apps",
            "tenant_base": "tenant/_base.html",
        })

@app.get("/tenant/apps/juguang")
async def tenant_apps_juguang(request: Request):
    return templates_engine.TemplateResponse(request, "apps/juguang.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/tenant/apps/kuaishou-card")
async def tenant_apps_kuaishou_card(request: Request):
    return templates_engine.TemplateResponse(request, "apps/kuaishou-card.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/apps/digital-human")
async def apps_digital_human(request: Request):
    from app.core.config import get_settings
    settings = get_settings()
    heygen_configured = bool(
        getattr(settings, "heygen_api_key", "") and
        settings.heygen_api_key != "sk-your-heygen-key-here"
    )
    return templates_engine.TemplateResponse(request, "apps/digital_human.html", {
        "request": request, "active_section": "apps",
        "is_admin": getattr(request.state, "user", {}).get("role") == "admin",
        "is_tenant": getattr(request.state, "is_tenant", False),
        "heygen_configured": heygen_configured,
    })

@app.get("/tenant/apps/digital-human")
async def tenant_apps_digital_human(request: Request):
    from app.core.config import get_settings
    settings = get_settings()
    heygen_configured = bool(
        getattr(settings, "heygen_api_key", "") and
        settings.heygen_api_key != "sk-your-heygen-key-here"
    )
    return templates_engine.TemplateResponse(request, "apps/digital_human.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_admin": False,
        "is_tenant": True,
        "heygen_configured": heygen_configured,
    })

@app.get("/tenant/apps/oss-replace")
async def tenant_apps_oss_replace(request: Request):
    import json
    from app.models.all import Tenant
    from app.core.database import AsyncSessionLocal

    tid = getattr(request.state, "tenant_id", None)
    tenant_name = ""
    tenant_subdomain = ""
    tenant_qr_url = ""

    if tid:
        try:
            async with AsyncSessionLocal() as db:
                from sqlalchemy import select
                from uuid import UUID
                from app.core.config import get_settings
                row = await db.execute(select(Tenant).where(Tenant.id == UUID(tid)))
                t = row.scalar_one_or_none()
                if t:
                    tenant_name = t.name
                    tenant_subdomain = t.subdomain
                    settings = json.loads(t.settings) if t.settings else {}
                    qr_key = settings.get("qr_oss_key", "")
                    if qr_key:
                        s = get_settings()
                        tenant_qr_url = f"https://{s.oss_bucket}.{s.oss_endpoint}/{qr_key}"
        except Exception:
            pass

    return templates_engine.TemplateResponse(request, "apps/oss_replace.html", {
        "request": request, "active_section": "apps",
        "user_role": "tenant",
        "is_tenant": True,
        "base_template": "tenant/_base.html",
        "tenant_base": "tenant/_base.html",
        "tenant_name": tenant_name,
        "tenant_subdomain": tenant_subdomain,
        "tenant_qr_url": tenant_qr_url,
    })

@app.get("/tenant/apps/studio")
async def tenant_apps_studio(request: Request):
    return templates_engine.TemplateResponse(request, "apps/studio.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/tenant/apps/studio/templates")
async def tenant_apps_studio_templates(request: Request):
    return templates_engine.TemplateResponse(request, "apps/studio_templates.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
    })

@app.get("/tenant/apps/diy-miniapp")
async def tenant_apps_diy_miniapp(request: Request):
    return templates_engine.TemplateResponse(request, "apps/diy-miniapp.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })

@app.get("/tenant/apps/coupon-mgmt")
async def tenant_apps_coupon_mgmt(request: Request):
    return templates_engine.TemplateResponse(request, "apps/coupon-mgmt.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })

@app.get("/tenant/apps/verifier-mgmt")
async def tenant_apps_verifier_mgmt(request: Request):
    return templates_engine.TemplateResponse(request, "apps/verifier-mgmt.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })

@app.get("/tenant/apps/manager-mgmt")
async def tenant_apps_manager_mgmt(request: Request):
    return templates_engine.TemplateResponse(request, "apps/manager-mgmt.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })

@app.get("/tenant/apps/group-buy-mgmt")
async def tenant_apps_group_buy_mgmt(request: Request):
    return templates_engine.TemplateResponse(request, "apps/group-buy-mgmt.html", {
        "request": request, "active_section": "apps",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })


@app.get("/tenant/wxpay-config")
async def tenant_wxpay_config_page(request: Request):
    """商户微信支付配置页面"""
    return templates_engine.TemplateResponse(request, "tenant/wxpay-config.html", {
        "request": request, "active_section": "settings",
        "tenant_base": "tenant/_base.html",
        "is_tenant": True,
        "tenant_id": getattr(request.state, "tenant_id", None),
        "user_id": getattr(request.state, "user_id", None),
    })
