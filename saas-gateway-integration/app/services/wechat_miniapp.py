"""WeChat mini-program helpers shared by server-side promotion features."""

from __future__ import annotations

import json
import time

import httpx


_ACCESS_TOKEN_CACHE: dict[str, tuple[str, float]] = {}


class WechatMiniProgramError(RuntimeError):
    """Raised when WeChat returns a non-image response."""


async def get_access_token(appid: str, secret: str, *, force_refresh: bool = False) -> str:
    """Return a cached mini-program access token."""
    appid = str(appid or "").strip()
    secret = str(secret or "").strip()
    if not appid or not secret:
        raise WechatMiniProgramError("商户未配置小程序 AppID 或 AppSecret")

    now = time.time()
    cached = _ACCESS_TOKEN_CACHE.get(appid)
    if not force_refresh and cached and cached[1] > now:
        return cached[0]

    async with httpx.AsyncClient(timeout=15) as client:
        response = await client.get(
            "https://api.weixin.qq.com/cgi-bin/token",
            params={
                "grant_type": "client_credential",
                "appid": appid,
                "secret": secret,
            },
        )
    data = response.json()
    token = str(data.get("access_token") or "").strip()
    if not token:
        raise WechatMiniProgramError(
            str(data.get("errmsg") or "获取微信 access_token 失败")
        )

    expires_in = int(data.get("expires_in") or 7200)
    _ACCESS_TOKEN_CACHE[appid] = (token, now + max(expires_in - 300, 60))
    return token


async def generate_miniapp_code(
    appid: str,
    secret: str,
    *,
    page: str,
    scene: str,
    width: int = 430,
    env_version: str = "release",
) -> tuple[bytes, str]:
    """Generate an unlimited mini-program code and return its bytes and MIME type."""
    page = str(page or "").strip().lstrip("/")
    scene = str(scene or "").strip()
    if not page or not scene:
        raise WechatMiniProgramError("生成小程序码缺少页面或场景参数")
    if len(scene) > 32:
        raise WechatMiniProgramError("小程序码 scene 不能超过 32 个字符")

    payload = {
        "scene": scene,
        "page": page,
        "width": max(280, min(int(width), 1280)),
        "check_path": False,
        "env_version": env_version,
    }

    for attempt in range(2):
        token = await get_access_token(appid, secret, force_refresh=attempt > 0)
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.weixin.qq.com/wxa/getwxacodeunlimit",
                params={"access_token": token},
                json=payload,
            )

        content_type = response.headers.get("content-type", "").lower()
        if response.status_code == 200 and content_type.startswith("image/"):
            return response.content, content_type.split(";", 1)[0]

        try:
            error_data = response.json()
        except (ValueError, json.JSONDecodeError):
            error_data = {}

        errcode = int(error_data.get("errcode") or 0)
        if errcode in (40001, 42001) and attempt == 0:
            continue
        raise WechatMiniProgramError(
            str(error_data.get("errmsg") or "微信生成小程序码失败")
        )

    raise WechatMiniProgramError("微信生成小程序码失败")


async def generate_miniapp_url_link(
    appid: str,
    secret: str,
    *,
    page: str,
    query: str = "",
    env_version: str = "release",
) -> str:
    """Generate a permanent official WeChat URL Link for a released page."""
    page = str(page or "").strip()
    if not page:
        raise WechatMiniProgramError("生成小程序链接缺少页面路径")
    if not page.startswith("/"):
        page = "/" + page

    payload = {
        "path": page,
        "query": str(query or "").strip(),
        "expire_type": 0,
        "env_version": env_version,
    }

    for attempt in range(2):
        token = await get_access_token(appid, secret, force_refresh=attempt > 0)
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.post(
                "https://api.weixin.qq.com/wxa/generate_urllink",
                params={"access_token": token},
                json=payload,
            )

        try:
            data = response.json()
        except (ValueError, json.JSONDecodeError):
            data = {}

        url_link = str(data.get("url_link") or "").strip()
        if response.status_code == 200 and url_link:
            return url_link

        errcode = int(data.get("errcode") or 0)
        if errcode in (40001, 42001) and attempt == 0:
            continue
        if errcode == 85079:
            raise WechatMiniProgramError("小程序尚未发布，发布正式版后才能生成专属链接")
        if errcode == 40002:
            raise WechatMiniProgramError("当前小程序主体暂无生成专属链接的权限")
        raise WechatMiniProgramError(
            str(data.get("errmsg") or "微信生成小程序专属链接失败")
        )

    raise WechatMiniProgramError("微信生成小程序专属链接失败")
