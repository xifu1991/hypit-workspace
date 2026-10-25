"""
核心配置 — 从 .env 和默认值加载
"""
from pydantic_settings import BaseSettings
from functools import lru_cache
import os


class Settings(BaseSettings):
    # ── 数据库 ──
    database_url: str = "postgresql+asyncpg://reedbook:reedbook2024@127.0.0.1:5432/ad_creative_hub"

    # ── JWT ──
    secret_key: str = "change-me-to-a-random-string-at-least-32-chars"
    access_token_expire_minutes: int = 10080  # 7 天

    # ── 服务 ──
    port: int = 4000
    host: str = "0.0.0.0"

    # ── ComfyUI ──
    comfyui_base_url: str = "http://127.0.0.1:8188"

    # ── 文件存储 ──
    data_dir: str = "./data"
    outputs_dir: str = "./data/outputs"
    templates_dir: str = "./data/templates"

    # ── 阿里云 OSS ──
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_endpoint: str = "oss-cn-shenzhen.aliyuncs.com"
    oss_bucket: str = "hypelux2024"
    oss_base_path: str = "games/chl/"

    # ── Token 定价 ──
    token_cost_image: int = 1
    token_cost_video: int = 3
    token_cost_video_with_audio: int = 5

    # ── 微信支付回调基础URL ──
    wxpay_notify_base_url: str = "https://niuniu.xhscdn.cn"
    gateway_recharge_payment_tenant_name: str = "阿彭牛排"
    gateway_wxpay_appid: str = ""
    gateway_wxpay_public_key_path: str = ""
    gateway_wxpay_public_key_id: str = ""
    gateway_wxpay_api_v3_key: str = ""

    # ── 情报局资讯采集 ──
    intelligence_sync_enabled: bool = False
    intelligence_sync_interval_minutes: int = 30
    intelligence_cleanup_enabled: bool = True
    intelligence_cleanup_interval_hours: int = 6
    intelligence_retention_days: int = 30
    intelligence_sync_timeout: int = 300
    intelligence_http_proxy: str = ""
    intelligence_sync_token: str = ""

    # ── Hypit 租户网关 ──
    hypit_gateway_base_url: str = "http://127.0.0.1:8791"
    hypit_gateway_bridge_secret: str = ""

    # ── 执行引擎（DeepSeek LLM） ──
    deepseek_api_key: str = ""
    deepseek_model: str = "deepseek-chat"
    deepseek_base_url: str = "https://api.deepseek.com"
    # ── 数字人（HeyGen） ──
    heygen_api_key: str = ""
    # ── HeyGen OAuth 2.0（PKCE 授权码流程，扣费走用户订阅计划） ──
    heygen_oauth_client_id: str = ""
    heygen_oauth_redirect_uri: str = ""
    # ── HyperFrames（AI 视觉素材） ──
    hyperframes_api_key: str = ""
    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache()
def get_settings() -> Settings:
    return Settings()
