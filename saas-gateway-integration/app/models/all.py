"""
数据模型 — 所有表
复用 reedbookAPI 的 app_users / license_keys，新建自有表
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Column,
    String,
    Integer,
    Float,
    DateTime,
    Text,
    Boolean,
    ForeignKey,
    Uuid,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from app.core.database import Base


# ═══════════════════════════════════════
# 复用表（只读映射，不创建）
# ═══════════════════════════════════════

class User(Base):
    """映射 reedbookAPI 已有的 app_users 表"""
    __tablename__ = "app_users"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(200), unique=True)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(50), default="user")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    tokens = Column(Integer, default=100)


class LicenseKey(Base):
    """映射 reedbookAPI 已有的 license_keys 表"""
    __tablename__ = "license_keys"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    key = Column(String(100), unique=True, nullable=False, index=True)
    tokens = Column(Integer, nullable=False)
    is_used = Column(Boolean, default=False)
    used_by = Column(Uuid(), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    used_at = Column(DateTime(timezone=True))


# ═══════════════════════════════════════
# 新平台自有表
# ═══════════════════════════════════════

class Industry(Base):
    """行业分类"""
    __tablename__ = "industries"

    id = Column(String(10), primary_key=True)
    name = Column(String(50), nullable=False, unique=True)   # 餐饮/美业/零售/电商/教育
    icon = Column(String(10), default="🏪")                   # Emoji图标
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    templates = relationship("AdTemplate", back_populates="industry")


class AdTemplate(Base):
    """广告模板"""
    __tablename__ = "ad_templates"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    category = Column(String(50))                       # image / video / video_audio
    style = Column(String(100))                         # chibi-3d / cyberpunk / ...
    thumbnail_url = Column(String(500))
    prompt = Column(Text, nullable=False)               # 核心提示词
    negative_prompt = Column(Text)
    workflow_json = Column(Text)                        # ComfyUI 工作流 JSON
    variable_slots = Column(Text)                       # JSON数组：可变槽位定义
    token_cost = Column(Integer, default=1)             # 生成消耗Token
    is_public = Column(Boolean, default=True)
    is_published = Column(Boolean, default=False)       # 是否发布到小程序
    usage_count = Column(Integer, default=0)
    sort_order = Column(Integer, default=0)             # 排序权重
    tags = Column(Text)                                 # JSON数组：标签列表
    industry_id = Column(String(10), ForeignKey("industries.id"), nullable=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)
    skill_id = Column(Uuid(), ForeignKey("skills.id"), nullable=True)           # 所属Skill（通过Skill链到Agent→行业+商户）
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    industry = relationship("Industry", back_populates="templates")


class GenerationRecord(Base):
    """生成记录"""
    __tablename__ = "generation_records"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    template_id = Column(Uuid(), ForeignKey("ad_templates.id"), nullable=True)
    status = Column(String(20), default="pending")      # pending / processing / done / failed
    prompt_used = Column(Text)
    result_url = Column(String(500))
    token_cost = Column(Integer, default=0)
    error_message = Column(Text)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    completed_at = Column(DateTime(timezone=True))


class TokenLog(Base):
    """Token 流水"""
    __tablename__ = "token_logs"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    amount = Column(Integer, nullable=False)            # +为充值，-为消费
    reason = Column(String(200))                         # "license_key", "generation", "admin_grant"
    ref_id = Column(Uuid())                  # 关联的卡密ID或生成记录ID
    balance_after = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 应用中心 — 小红书聚光
# ═══════════════════════════════════════

class JuguangAccount(Base):
    """小红书聚光投放账号"""
    __tablename__ = "juguang_accounts"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    platform = Column(String(20), default="xiaohongshu")  # 平台标识
    nickname = Column(String(100))                         # 账号昵称
    username = Column(String(200), nullable=False)         # 登录账号
    password_enc = Column(String(500))                     # 加密密码
    # 聚光Cookie（JSON存储）
    cookies = Column(Text)                                 # Playwright采集到的cookies JSON
    cookie_status = Column(String(20), default="none")     # none / collecting / success / failed
    cookie_error = Column(Text)
    cookie_updated_at = Column(DateTime(timezone=True))
    proxy = Column(String(200))                            # 可选代理
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class JuguangPlan(Base):
    """聚光投放计划"""
    __tablename__ = "juguang_plans"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    account_id = Column(Uuid(), ForeignKey("juguang_accounts.id"), nullable=False, index=True)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    plan_type = Column(String(20), nullable=False)         # fullsite / feed / search  (全站/信息流/搜索)
    plan_name = Column(String(200))
    budget = Column(Float, default=0)                      # 预算
    status = Column(String(20), default="draft")           # draft / submitted / success / failed
    platform_response = Column(Text)                       # 聚光平台返回的原始数据
    error_message = Column(Text)
    submitted_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class JuguangAdUnit(Base):
    """聚光单元（广告组）"""
    __tablename__ = "juguang_ad_units"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    plan_id = Column(Uuid(), ForeignKey("juguang_plans.id"), nullable=False, index=True)
    account_id = Column(Uuid(), ForeignKey("juguang_accounts.id"), nullable=False, index=True)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    unit_type = Column(String(20), nullable=False)         # plan_id / search_id
    unit_value = Column(String(200))                       # 计划ID或搜索ID的值
    status = Column(String(20), default="draft")
    platform_response = Column(Text)
    error_message = Column(Text)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class JuguangProfile(Base):
    """聚光提交Profile（存x-s/x-s-common/x-t/body签名）"""
    __tablename__ = "juguang_profiles"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    account_id = Column(Uuid(), ForeignKey("juguang_accounts.id"), nullable=False, index=True)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    plan_type = Column(String(20), nullable=False)         # fullsite / feed / search
    x_s = Column(String(500))
    x_s_common = Column(Text)
    x_t = Column(String(20))
    x_trace_id = Column(String(50))
    referer = Column(String(500))
    body = Column(Text)
    cookie = Column(Text, default="")
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 应用中心 — 快手卡片
# ═══════════════════════════════════════

class KsAccount(Base):
    """快手广告投放账号"""
    __tablename__ = "ks_accounts"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    nickname = Column(String(100))                         # 账号别名
    account_id = Column(String(100), nullable=False)       # __accountId__ 值
    remark = Column(String(300))                           # 备注说明
    cookies = Column(Text)                                 # Cookie 文本（加密存储）
    cookie_status = Column(String(20), default="none")     # none / valid / expired / error
    cookie_error = Column(Text)
    cookie_updated_at = Column(DateTime(timezone=True))
    is_active = Column(Boolean, default=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class KsLandingPage(Base):
    """快手落地页"""
    __tablename__ = "ks_landing_pages"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    account_id = Column(Uuid(), ForeignKey("ks_accounts.id"), nullable=False, index=True)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)

    title = Column(String(200), nullable=False)                                   # 页面标题
    company_name = Column(String(200), default="")                                # 公司名称
    image_url = Column(String(1000), default="")                                  # 主图URL
    ks_page_name = Column(String(100), default="1")                               # 快手方 page name
    components_json = Column(Text, default="{}")                                  # 完整组件JSON
    ks_page_id = Column(String(100), default="")                                  # 快手返回的落地页ID
    ks_page_url = Column(String(1000), default="")                                # 快手返回的落地页URL
    status = Column(String(20), default="draft")                                  # draft / submitted / success / failed
    error_message = Column(Text)
    qrcode_url = Column(String(1000), default="")                                 # 手动上传的二维码图片URL
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 创意工作室
# ═══════════════════════════════════════

class StudioProject(Base):
    """创意工作室项目"""
    __tablename__ = "studio_projects"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    client_name = Column(String(200))
    industry_id = Column(String(10), ForeignKey("industries.id"))
    status = Column(String(20), default="draft")
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True)
    total_shot_count = Column(Integer, default=0)
    total_duration = Column(Float, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    characters = relationship("StudioCharacter", back_populates="project", cascade="all, delete-orphan")
    scenes = relationship("StudioScene", back_populates="project", cascade="all, delete-orphan")
    shots = relationship("StudioShot", back_populates="project", cascade="all, delete-orphan")


class StudioCharacter(Base):
    """项目角色"""
    __tablename__ = "studio_characters"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(), ForeignKey("studio_projects.id"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    description = Column(Text)
    voice_desc = Column(String(200))
    reference_image_url = Column(String(500))
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    project = relationship("StudioProject", back_populates="characters")


class StudioScene(Base):
    """项目场景"""
    __tablename__ = "studio_scenes"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(), ForeignKey("studio_projects.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    reference_image_url = Column(String(500))
    tags = Column(Text)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    project = relationship("StudioProject", back_populates="scenes")


class StudioShot(Base):
    """分镜镜头"""
    __tablename__ = "studio_shots"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    project_id = Column(Uuid(), ForeignKey("studio_projects.id"), nullable=False, index=True)
    scene_id = Column(Uuid(), ForeignKey("studio_scenes.id"))
    shot_number = Column(Integer, nullable=False)
    duration = Column(Float, default=4)
    dialogue = Column(Text)
    chinese_desc = Column(Text)
    english_prompt = Column(Text)
    reference_image_url = Column(String(500))
    audio_url = Column(String(500))
    video_url = Column(String(500))
    status = Column(String(20), default="draft")
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    project = relationship("StudioProject", back_populates="shots")


class StudioTemplate(Base):
    """项目模板（发布为模板供一键复用）"""
    __tablename__ = "studio_templates"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    source_project_id = Column(Uuid(), ForeignKey("studio_projects.id"), nullable=False)
    name = Column(String(200), nullable=False)
    description = Column(Text)
    industry_id = Column(String(10), ForeignKey("industries.id"))
    thumbnail_url = Column(String(500))
    tags = Column(Text)
    usage_count = Column(Integer, default=0)
    is_published = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# SaaS 商户管理
# ═══════════════════════════════════════

class Tenant(Base):
    """SaaS商户"""
    __tablename__ = "tenants"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)              # 商户名称
    subdomain = Column(String(50), unique=True, nullable=False)  # 子域名标识
    logo_url = Column(String(500), default="")
    contact_name = Column(String(100), default="")
    contact_email = Column(String(200), default="")
    is_active = Column(Boolean, default=True)
    settings = Column(Text, default="{}")                   # JSON: 商户配置
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class TenantUser(Base):
    """用户-商户关联"""
    __tablename__ = "tenant_users"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    role_in_tenant = Column(String(20), default="admin")    # admin / editor / viewer
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class RoleModel(Base):
    """自定义角色（用户可增删改）"""
    __tablename__ = "roles"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    name = Column(String(50), unique=True, nullable=False, index=True)
    description = Column(String(200), default="")
    permissions = Column(Text, default="[]")  # JSON: ["view:dashboard", ...]
    is_builtin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 商户独立后台 — 微信小程序用户
# ═══════════════════════════════════════

class TenantUserProfile(Base):
    """商户的微信小程序用户（非系统 app_users）"""
    __tablename__ = "tenant_user_profiles"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    openid = Column(String(100), unique=True, nullable=False, index=True)   # 微信openid
    nickname = Column(String(100), default="")
    avatar_url = Column(String(500), default="")
    phone = Column(String(20), default="")
    license_plate = Column(String(20), default="")          # 车牌号
    address = Column(String(500), default="")                # 服务地址
    session_key = Column(String(200), default="")            # 微信 session_key（用于bindPhone解密）
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 商户独立后台 — 商品
# ═══════════════════════════════════════

class Product(Base):
    """商户服务商品"""
    __tablename__ = "products"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(200), nullable=False)               # 商品名称
    original_price = Column(Float, default=0.0)              # 原价
    special_price = Column(Float, default=0.0)               # 特价
    image_url = Column(String(500), default="")              # 商品图片
    images = Column(JSONB, default=list)                     # 商品详情图集（首图作为封面）
    package_details = Column(Text, default="")               # 套餐详情（富文本/图文HTML）
    # 商品规格（JSON: [{name, options: [{label, price, original_price}]}]）
    specs = Column(JSONB, nullable=False, default=list, server_default=text("'[]'::jsonb"))
    vehicle_type = Column(String(20), default="")            # 车型标签：sedan/suv/van/premium/economy/luxury
    vehicle_types = Column(JSONB, default=list)              # 多车型标签：["sedan", "suv"]
    sales_count = Column(Integer, default=0)                 # 已售数量（后台可设置）
    is_active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class MallOrder(Base):
    """菜谱商城订单（商品下单 + 微信支付）"""
    __tablename__ = "mall_orders"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)

    out_trade_no = Column(String(100), unique=True, index=True)   # 商户订单号
    transaction_id = Column(String(100), default="")              # 微信支付交易号

    total_amount = Column(Float, nullable=False, default=0.0)     # 商品总额
    shipping_fee = Column(Float, nullable=False, default=0.0)     # 运费
    coupon_id = Column(Uuid(), ForeignKey("mall_user_coupons.id"), nullable=True, index=True)
    coupon_discount = Column(Float, nullable=False, default=0.0)  # 优惠券抵扣
    final_amount = Column(Float, nullable=False, default=0.0)     # 实付金额

    receiver_name = Column(String(50), default="")
    receiver_phone = Column(String(20), default="")
    receiver_region = Column(String(200), default="")
    receiver_detail = Column(String(500), default="")

    items = Column(JSONB, default=list)                           # 商品快照 [{id,title,price,qty,cover}]
    item_count = Column(Integer, default=0)

    status = Column(String(20), default="pending")                # pending/shipped/completed/cancelled/refunding/refunded
    payment_status = Column(String(20), default="unpaid")         # unpaid/paid/refunded
    remark = Column(Text, default="")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    paid_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class MallCouponTemplate(Base):
    """商城优惠券活动模板（当前用于新人礼）。"""
    __tablename__ = "mall_coupon_templates"
    __table_args__ = (
        UniqueConstraint("tenant_id", "campaign_key", name="uq_mall_coupon_campaign"),
        {"extend_existing": True},
    )

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    campaign_key = Column(String(50), nullable=False, default="newcomer")
    name = Column(String(100), nullable=False, default="新人专享券")
    description = Column(String(500), default="")
    discount_type = Column(String(20), nullable=False, default="fixed")
    discount_value = Column(Float, nullable=False, default=20.0)
    min_amount = Column(Float, nullable=False, default=99.0)
    total_quantity = Column(Integer, nullable=False, default=0)   # 0 = 不限
    valid_days = Column(Integer, nullable=False, default=30)
    is_active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class MallUserCoupon(Base):
    """用户持有的商城券；权益字段落库快照，后台改模板不影响已发券。"""
    __tablename__ = "mall_user_coupons"
    __table_args__ = (
        UniqueConstraint("profile_id", "grant_key", name="uq_mall_user_coupon_grant"),
        {"extend_existing": True},
    )

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    template_id = Column(Uuid(), ForeignKey("mall_coupon_templates.id"), nullable=False, index=True)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    grant_key = Column(String(80), nullable=False, default="newcomer")
    name = Column(String(100), nullable=False, default="新人专享券")
    description = Column(String(500), default="")
    discount_type = Column(String(20), nullable=False, default="fixed")
    discount_value = Column(Float, nullable=False, default=0.0)
    min_amount = Column(Float, nullable=False, default=0.0)
    status = Column(String(20), nullable=False, default="unused")  # unused/locked/used/expired
    order_id = Column(Uuid(), nullable=True, index=True)          # 当前锁定或核销订单
    valid_from = Column(DateTime(timezone=True), nullable=False)
    valid_until = Column(DateTime(timezone=True), nullable=False, index=True)
    used_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 应用中心 — 文案狗
# ═══════════════════════════════════════

class WenangouRecord(Base):
    """文案狗 — 保存的文案记录"""
    __tablename__ = "wenangou_records"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True, index=True)  # SaaS 商户隔离
    prompt = Column(Text, nullable=False)
    skill = Column(String(50), default="general")
    model_used = Column(String(50), default="deepseek-chat")
    types = Column(Text, nullable=False)           # JSON array: ["knowledge","interact"]
    content = Column(Text, nullable=False)          # JSON object: {"knowledge":"...","interact":"..."}
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 情报局 — 资讯文章
# ═══════════════════════════════════════

class IntelligenceArticle(Base):
    """情报局 — 聚合的资讯文章"""
    __tablename__ = "intelligence_articles"

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    category = Column(String(20), nullable=False, index=True)   # hot/tech/geo/finance/health/food/military/international/business
    title = Column(String(500), nullable=False)
    description = Column(Text, default="")
    source = Column(String(200), default="")                     # 来源名称
    source_url = Column(String(1000), default="")                # 原文链接
    badge = Column(String(20), default="新")                     # 标签：热/新/重磅等
    image_url = Column(String(1000), default="")
    content = Column(Text, default="")                           # 文章正文（可选）
    published_at = Column(DateTime(timezone=True), nullable=True) # 原始发布时间
    guid = Column(String(500), unique=True, nullable=False)       # 去重ID（RSS guid或自定义）
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# DIY 小程序配置
# ═══════════════════════════════════════

class TenantMiniappConfig(Base):
    """商户DIY小程序配置 — 品牌色、首页、菜单、主题、联系方式等，按tenant_id完全隔离"""
    __tablename__ = "tenant_miniapp_configs"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, unique=True, index=True)

    # 品牌设置
    brand_name = Column(String(100), default="")
    logo_url = Column(String(500), default="")
    primary_color = Column(String(10), default="#3B82F6")
    secondary_color = Column(String(10), default="#10B981")

    # 首页布局 (JSON: {hero_banner: [...], show_categories: bool, show_products: bool, ...})
    homepage_layout = Column(Text, default="{}")
    # 底部菜单 (JSON: [{name, icon, page_path}, ...])
    menu_config = Column(Text, default="[]")
    # 主题样式 (JSON: {card_radius, card_shadow, font_family})
    theme_config = Column(Text, default="{}")
    # 联系方式 (JSON: {phone, address, business_hours})
    contact_info = Column(Text, default="{}")
    # 关于我们
    about_content = Column(Text, default="")

    # 小程序凭据（用于前端小程序对接）
    miniapp_appid = Column(String(100), default="")
    miniapp_appsecret = Column(String(200), default="")
    # 抖音小程序凭据
    douyin_appid = Column(String(100), default="")
    douyin_appsecret = Column(String(200), default="")

    # 微信支付配置（商户自行在后台录入）
    wxpay_mchid = Column(String(50), default="")                # 微信商户号
    wxpay_api_v3_key = Column(String(200), default="")          # APIv3密钥
    wxpay_cert_pem = Column(Text, default="")                   # apiclient_cert.pem
    wxpay_key_pem = Column(Text, default="")                    # apiclient_key.pem (私钥)
    wxpay_serial_no = Column(String(200), default="")           # 微信支付平台证书序列号
    wxpay_notify_url = Column(String(500), default="")          # 自定义支付通知URL（可选）
    payment_name = Column(String(100), default="微信支付")       # 支付名称
    payment_method = Column(String(50), default="wxpay")        # 支付方式
    payment_type = Column(String(50), default="JSAPI")          # 支付类型

    # 发布状态
    is_published = Column(Boolean, default=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 工作流 — Agent 定义
# ═══════════════════════════════════════

class WorkflowAgent(Base):
    """导入的 Agent 定义 — 行业+多阶段Pipeline"""
    __tablename__ = "workflow_agents"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    industry_id = Column(String(10), ForeignKey("industries.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)  # 授权给哪个商户
    agent_definition = Column(Text, default="{}")   # JSON: role, stages, tools, rules, memory
    output_template = Column(Text, default="{}")    # JSON: 输出模板
    variable_slots = Column(Text, default="[]")     # JSON: [{name, type, label, default}]
    version = Column(Integer, default=1)
    status = Column(String(20), default="active")   # draft / active / archived
    is_builtin = Column(Boolean, default=False)
    created_by = Column(Uuid(), ForeignKey("app_users.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    industry = relationship("Industry", backref="workflow_agents")
    tenant = relationship("Tenant", backref="workflow_agents")


class Skill(Base):
    """Agent 技能 — 独立的系统提示词（防止环境污染）"""
    __tablename__ = "skills"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text, default="")
    agent_id = Column(Uuid(), ForeignKey("workflow_agents.id"), nullable=False, index=True)
    system_prompt = Column(Text, nullable=False)      # 核心技能提示词
    industry_id = Column(String(10), ForeignKey("industries.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    is_builtin = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    agent = relationship("WorkflowAgent", backref="skills")
    industry = relationship("Industry")
    tenant = relationship("Tenant")


# ═══════════════════════════════════════
# 洗车小程序 — 上门洗车 B2C
# ═══════════════════════════════════════


class CarWashStore(Base):
    """门店信息"""
    __tablename__ = "car_wash_stores"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(100), nullable=False)
    address = Column(String(300), default="")
    lat = Column(Float, default=0.0)
    lng = Column(Float, default=0.0)
    phone = Column(String(20), default="")
    business_hours = Column(String(200), default="")
    image_url = Column(String(500), default="")
    is_active = Column(Boolean, default=True)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


# ═══════════════════════════════════════
# 数字人 — HeyGen OAuth 2.0 授权
# ═══════════════════════════════════════

class HeyGenOAuth(Base):
    """HeyGen OAuth 2.0 Token 存储（PKCE 授权码流程）

    每个用户/商户可绑定自己的 HeyGen 账号，扣费走订阅计划。
    """
    __tablename__ = "heygen_oauth_tokens"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    user_id = Column(Uuid(), ForeignKey("app_users.id"), nullable=False, unique=True, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=True, index=True)

    # ── OAuth 令牌 ──
    access_token = Column(Text, nullable=False)
    refresh_token = Column(Text, nullable=True)
    token_expires_at = Column(DateTime(timezone=True), nullable=True)

    # ── PKCE 临时数据 ──
    code_verifier = Column(String(200), nullable=True)          # 授权过程中暂存

    # ── HeyGen 账户信息 ──
    heygen_user_id = Column(String(100), nullable=True)
    heygen_email = Column(String(200), nullable=True)
    billing_type = Column(String(30), nullable=True)            # wallet / subscription / usage_based
    billing_info = Column(Text, nullable=True)                  # JSON: 账户余额/订阅计划详情

    # ── 状态 ──
    is_active = Column(Boolean, default=True)
    last_synced_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class CarWashVehicle(Base):
    """用户车牌/车辆信息"""
    __tablename__ = "car_wash_vehicles"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    plate_number = Column(String(20), nullable=False)       # 车牌号
    brand = Column(String(100), default="")                 # 品牌型号
    color = Column(String(20), default="")                  # 颜色
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashAddress(Base):
    """用户服务地址"""
    __tablename__ = "car_wash_addresses"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    full_address = Column(String(500), nullable=False)      # 完整地址文本
    detail = Column(String(200), default="")                # 门牌号/补充
    lat = Column(Float, default=0.0)
    lng = Column(Float, default=0.0)
    contact_name = Column(String(50), default="")
    contact_phone = Column(String(20), default="")
    is_default = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashCouponTemplate(Base):
    """优惠券模板（商户配置）"""
    __tablename__ = "car_wash_coupon_templates"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    name = Column(String(100), nullable=False)              # 优惠券名称
    description = Column(String(500), default="")
    discount_type = Column(String(20), default="fixed")     # fixed / percent
    discount_value = Column(Float, nullable=False)          # 减XX元 或 打XX折(0.8=8折)
    min_amount = Column(Float, default=0.0)                 # 满XX可用
    is_newbie = Column(Boolean, default=False)              # 是否新人专享
    total_quantity = Column(Integer, default=0)             # 总数量, 0=不限
    per_user_limit = Column(Integer, default=1)             # 每人限领
    valid_days = Column(Integer, default=30)                # 领取后有效天数
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashUserCoupon(Base):
    """用户已领取的优惠券"""
    __tablename__ = "car_wash_user_coupons"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    template_id = Column(Uuid(), ForeignKey("car_wash_coupon_templates.id"), nullable=False, index=True)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    status = Column(String(20), default="unused")           # unused / used / expired
    used_at = Column(DateTime(timezone=True))
    valid_from = Column(DateTime(timezone=True), nullable=False)
    valid_until = Column(DateTime(timezone=True), nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashOrder(Base):
    """洗车订单主表"""
    __tablename__ = "car_wash_orders"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)

    # 服务信息
    product_id = Column(Uuid(), ForeignKey("products.id"), nullable=False)
    product_name = Column(String(200), default="")
    product_price = Column(Float, default=0.0)
    quantity = Column(Integer, default=1)
    total_amount = Column(Float, nullable=False)        # 总价
    discount_amount = Column(Float, default=0.0)        # 优惠金额
    final_amount = Column(Float, nullable=False)        # 实付

    # 车辆 & 地址
    plate_number = Column(String(20), default="")       # 车牌号
    car_model = Column(String(100), default="")
    service_address = Column(String(500), default="")   # 服务地址文本
    contact_name = Column(String(50), default="")       # 收货人/联系人姓名
    contact_phone = Column(String(20), default="")      # 收货人/联系人电话

    # 时间
    service_date = Column(String(20), default="")       # 服务日期 YYYY-MM-DD
    service_time = Column(String(20), default="")       # 服务时间段
    remark = Column(Text, default="")

    # 状态
    status = Column(String(20), default="pending")      # pending / paid / in_progress / completed / cancelled / refunded
    payment_status = Column(String(20), default="unpaid")  # unpaid / paid / refunded
    out_trade_no = Column(String(100), unique=True, index=True)  # 商户订单号
    transaction_id = Column(String(100), default="")    # 微信支付交易号

    # 核销
    short_code = Column(String(10), default="")         # 5位核销短码
    verifier_profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=True)
    verified_at = Column(DateTime(timezone=True))

    # 优惠券
    coupon_id = Column(Uuid(), ForeignKey("car_wash_user_coupons.id"), nullable=True)

    # 团购
    group_buy_activity_id = Column(String(100), default="")
    group_buy_status = Column(String(20), default="")   # normal / grouped / joined

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    paid_at = Column(DateTime(timezone=True))
    completed_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class CarWashVerifier(Base):
    """核销员"""
    __tablename__ = "car_wash_verifiers"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    store_id = Column(Uuid(), ForeignKey("car_wash_stores.id"), nullable=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashManager(Base):
    """手机管理员 — 可在手机上查看所有订单"""
    __tablename__ = "car_wash_managers"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    profile_id = Column(Uuid(), ForeignKey("tenant_user_profiles.id"), nullable=False, index=True)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


class CarWashGroupBuyActivity(Base):
    """团购活动"""
    __tablename__ = "car_wash_group_buy_activities"
    __table_args__ = {"extend_existing": True}

    id = Column(Uuid(), primary_key=True, default=uuid.uuid4)
    tenant_id = Column(Uuid(), ForeignKey("tenants.id"), nullable=False, index=True)
    product_id = Column(Uuid(), ForeignKey("products.id"), nullable=True)
    name = Column(String(200), default="")
    description = Column(Text, default="")
    original_price = Column(Float, default=0.0)
    group_price = Column(Float, default=0.0)
    min_group_size = Column(Integer, default=3)
    max_group_size = Column(Integer, default=50)
    start_time = Column(DateTime(timezone=True))
    end_time = Column(DateTime(timezone=True))
    total_quantity = Column(Integer, default=0)
    sold_quantity = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
