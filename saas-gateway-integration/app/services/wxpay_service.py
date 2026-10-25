"""
微信支付服务 — 支持多商户号隔离的 APIv3 实现

使用方式:
  1. 商户在后台录入 wxpay_mchid / wxpay_api_v3_key / wxpay_serial_no / wxpay_private_key
  2. 小程序调 /api/miniapp/pay/create → 获取 prepay_id + 签名参数
  3. 小程序用这些参数调起微信支付
  4. 支付完成后微信异步通知 /api/miniapp/pay/notify
"""

import json
import time
import random
import string
import base64
import hashlib
import httpx
from datetime import datetime, timezone, timedelta
from uuid import UUID

WXPAY_API_BASE = "https://api.mch.weixin.qq.com"
_platform_cert_cache: dict = {}
_platform_cert_refreshed_at: dict = {}
_PLATFORM_CERT_REFRESH_SECONDS = 12 * 60 * 60


def generate_nonce_str(length=32) -> str:
    """生成随机字符串"""
    return "".join(random.choices(string.ascii_letters + string.digits, k=length))


def build_authorization_token(
    mchid: str,
    serial_no: str,
    private_key_pem: str,
    method: str,
    url: str,
    body: str,
    nonce_str: str = "",
    timestamp: str = "",
) -> tuple[str, str, str]:
    """
    构造微信支付 APIv3 请求的 Authorization 头

    Returns: (authorization, nonce_str, timestamp)
    """
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    if not nonce_str:
        nonce_str = generate_nonce_str()
    if not timestamp:
        timestamp = str(int(time.time()))

    # 构建签名串
    signature_str = f"{method}\n{url}\n{timestamp}\n{nonce_str}\n{body}\n"

    # 加载私钥并签名
    private_key = load_pem_private_key(
        private_key_pem.encode("utf-8"),
        password=None,
    )
    signature = private_key.sign(
        signature_str.encode("utf-8"),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    signature_b64 = base64.b64encode(signature).decode("utf-8")

    # 构造 Authorization
    token = (
        f'WECHATPAY2-SHA256-RSA2048 '
        f'mchid="{mchid}",'
        f'nonce_str="{nonce_str}",'
        f'serial_no="{serial_no}",'
        f'timestamp="{timestamp}",'
        f'signature="{signature_b64}"'
    )

    return token, nonce_str, timestamp


async def create_wxpay_order(
    appid: str,
    mchid: str,
    description: str,
    out_trade_no: str,
    amount_total: int,  # 单位：分
    openid: str,
    notify_url: str,
    serial_no: str,
    private_key_pem: str,
    time_expire: str = "",
) -> dict:
    """
    微信支付统一下单（JSAPI）

    返回包含 prepay_id 的数据，小程序端用此调起支付

    Returns: {"prepay_id": "...", "pay_params": {...}}
    """
    url_path = "/v3/pay/transactions/jsapi"
    url = f"{WXPAY_API_BASE}{url_path}"

    body_dict = {
        "appid": appid,
        "mchid": mchid,
        "description": description[:127],
        "out_trade_no": out_trade_no,
        "amount": {"total": amount_total, "currency": "CNY"},
        "payer": {"openid": openid},
        "notify_url": notify_url,
    }
    if time_expire:
        body_dict["time_expire"] = time_expire
    body_str = json.dumps(body_dict, ensure_ascii=False)

    # 生成签名
    auth_token, nonce_str, timestamp = build_authorization_token(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        method="POST",
        url=url_path,
        body=body_str,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            headers={
                "Authorization": auth_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "micloud-wxpay/1.0",
            },
            content=body_str,
            timeout=15,
        )
        result = resp.json()

    if resp.status_code != 200:
        raise Exception(f"微信支付下单失败 ({resp.status_code}): {result.get('message', '')}")

    prepay_id = result.get("prepay_id", "")

    # 构造小程序端调起支付的参数
    pay_params = build_miniapp_pay_params(
        appid=appid,
        prepay_id=prepay_id,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
    )

    return {
        "prepay_id": prepay_id,
        "pay_params": pay_params,
    }


async def create_native_wxpay_order(
    appid: str,
    mchid: str,
    description: str,
    out_trade_no: str,
    amount_total: int,
    notify_url: str,
    serial_no: str,
    private_key_pem: str,
    time_expire: str = "",
    platform_public_key_pem: str = "",
    platform_public_key_id: str = "",
) -> dict:
    """Create a WeChat Pay Native order and return its QR payload URL."""
    url_path = "/v3/pay/transactions/native"
    url = f"{WXPAY_API_BASE}{url_path}"
    body_dict = {
        "appid": appid,
        "mchid": mchid,
        "description": description[:127],
        "out_trade_no": out_trade_no,
        "amount": {"total": amount_total, "currency": "CNY"},
        "notify_url": notify_url,
    }
    if time_expire:
        body_dict["time_expire"] = time_expire
    body_str = json.dumps(body_dict, ensure_ascii=False, separators=(",", ":"))
    auth_token, _, _ = build_authorization_token(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        method="POST",
        url=url_path,
        body=body_str,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            headers={
                "Authorization": auth_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "micloud-wxpay/1.0",
            },
            content=body_str,
            timeout=15,
        )
        result = resp.json()

    if resp.status_code == 200:
        verify_platform_signature(
            body_str=resp.text,
            signature=resp.headers.get("Wechatpay-Signature", ""),
            serial_no=resp.headers.get("Wechatpay-Serial", ""),
            timestamp=resp.headers.get("Wechatpay-Timestamp", ""),
            nonce=resp.headers.get("Wechatpay-Nonce", ""),
            public_key_pem=platform_public_key_pem,
            public_key_id=platform_public_key_id,
        )
    if resp.status_code != 200 or not result.get("code_url"):
        raise Exception(
            f"微信支付扫码下单失败 ({resp.status_code}): {result.get('message', '')}"
        )
    return {"code_url": result["code_url"]}


def build_miniapp_pay_params(
    appid: str,
    prepay_id: str,
    serial_no: str,
    private_key_pem: str,
) -> dict:
    """
    构造小程序端调起微信支付所需的参数

    返回: {
        appId: "小程序appid",
        timeStamp: "时间戳",
        nonceStr: "随机串",
        package: "prepay_id=xxx",
        signType: "RSA",
        paySign: "签名"
    }
    """
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    timestamp = str(int(time.time()))
    nonce_str = generate_nonce_str()
    package = f"prepay_id={prepay_id}"

    # 签名串
    sign_str = f"{appid}\n{timestamp}\n{nonce_str}\n{package}\n"

    private_key = load_pem_private_key(
        private_key_pem.encode("utf-8"),
        password=None,
    )
    signature = private_key.sign(
        sign_str.encode("utf-8"),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )
    pay_sign = base64.b64encode(signature).decode("utf-8")

    return {
        "appId": appid,
        "timeStamp": timestamp,
        "nonceStr": nonce_str,
        "package": package,
        "signType": "RSA",
        "paySign": pay_sign,
    }


async def download_platform_certificates(
    mchid: str,
    serial_no: str,
    private_key_pem: str,
    api_v3_key: str,
) -> list[dict]:
    """Download and cache WeChat Pay platform certificates."""
    global _platform_cert_cache, _platform_cert_refreshed_at

    now = datetime.now(timezone.utc)
    for sid, entry in list(_platform_cert_cache.items()):
        if entry.get("expires_at") and entry["expires_at"] < now:
            del _platform_cert_cache[sid]
    refresh_key = f"{mchid}:{serial_no}"
    last_refresh = max(_platform_cert_refreshed_at.values(), default=None)
    is_fresh = bool(
        last_refresh
        and (now - last_refresh).total_seconds() < _PLATFORM_CERT_REFRESH_SECONDS
    )
    if _platform_cert_cache and is_fresh:
        return list(_platform_cert_cache.values())

    url_path = "/v3/certificates"
    auth_token, _, _ = build_authorization_token(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        method="GET",
        url=url_path,
        body="",
    )
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{WXPAY_API_BASE}{url_path}",
                headers={
                    "Authorization": auth_token,
                    "Accept": "application/json",
                    "User-Agent": "micloud-wxpay/1.0",
                },
                timeout=15,
            )
            result = resp.json()
    except Exception:
        if _platform_cert_cache:
            return list(_platform_cert_cache.values())
        raise
    if resp.status_code != 200:
        if _platform_cert_cache:
            return list(_platform_cert_cache.values())
        raise Exception(f"下载微信支付平台证书失败 ({resp.status_code}): {result.get('message', '')}")

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography import x509

    certs = []
    for cert_data in result.get("data", []):
        platform_serial = cert_data.get("serial_no", "")
        cert_info = cert_data.get("encrypt_certificate", {})
        cert_pem = AESGCM(api_v3_key.encode("utf-8")).decrypt(
            cert_info.get("nonce", "").encode("utf-8"),
            base64.b64decode(cert_info.get("ciphertext", "")),
            cert_info.get("associated_data", "").encode("utf-8"),
        ).decode("utf-8")
        try:
            cert = x509.load_pem_x509_certificate(cert_pem.encode("utf-8"))
            expires_at = cert.not_valid_after_utc
        except Exception:
            expires_at = now + timedelta(hours=12)
        entry = {
            "serial_no": platform_serial,
            "cert_pem": cert_pem,
            "expires_at": expires_at,
        }
        _platform_cert_cache[platform_serial] = entry
        certs.append(entry)

    if not certs:
        raise Exception("微信支付平台证书列表为空")
    _platform_cert_refreshed_at[refresh_key] = now
    return certs


def _load_platform_public_key(public_key_pem: str):
    from cryptography.hazmat.primitives.serialization import load_pem_public_key

    key_text = str(public_key_pem or "").strip()
    if not key_text:
        raise ValueError("未配置微信支付公钥")
    try:
        return load_pem_public_key(key_text.encode("utf-8"))
    except ValueError as exc:
        raise ValueError("微信支付公钥 PEM 格式无效") from exc


async def prepare_platform_signature_verification(
    mchid: str,
    serial_no: str,
    private_key_pem: str,
    api_v3_key: str,
    public_key_pem: str = "",
    public_key_id: str = "",
) -> str:
    """Prepare either WeChat Pay public-key or legacy platform-certificate mode."""
    key_pem = str(public_key_pem or "").strip()
    key_id = str(public_key_id or "").strip()
    if key_pem or key_id:
        if not key_pem or not key_id:
            raise ValueError("微信支付公钥 PEM 和公钥 ID 必须成对配置")
        _load_platform_public_key(key_pem)
        return "public_key"
    await download_platform_certificates(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        api_v3_key=api_v3_key,
    )
    return "platform_certificate"


def verify_platform_signature(
    body_str: str,
    signature: str,
    serial_no: str,
    timestamp: str,
    nonce: str,
    public_key_pem: str = "",
    public_key_id: str = "",
) -> None:
    """Verify a WeChat Pay APIv3 response signature."""
    if not all((signature, serial_no, timestamp, nonce)):
        raise ValueError("微信支付响应缺少签名参数")

    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.asymmetric import padding

    key_pem = str(public_key_pem or "").strip()
    key_id = str(public_key_id or "").strip()
    if key_pem and key_id:
        if serial_no != key_id:
            raise ValueError(
                f"微信支付公钥 ID 不匹配: 收到 {serial_no}"
            )
        public_key = _load_platform_public_key(key_pem)
    else:
        cert_entry = _platform_cert_cache.get(serial_no)
        if not cert_entry:
            raise ValueError(f"未找到微信支付平台证书: {serial_no}")
        from cryptography import x509

        cert = x509.load_pem_x509_certificate(
            cert_entry["cert_pem"].encode("utf-8")
        )
        public_key = cert.public_key()

    public_key.verify(
        base64.b64decode(signature),
        f"{timestamp}\n{nonce}\n{body_str}\n".encode("utf-8"),
        padding.PKCS1v15(),
        hashes.SHA256(),
    )


def verify_notify_signature(
    body_str: str,
    signature: str,
    serial_no: str,
    api_v3_key: str,
    timestamp: str,
    nonce: str,
    public_key_pem: str = "",
    public_key_id: str = "",
) -> dict:
    """Verify the callback signature, then decrypt its APIv3 resource."""
    verify_platform_signature(
        body_str=body_str,
        signature=signature,
        serial_no=serial_no,
        timestamp=timestamp,
        nonce=nonce,
        public_key_pem=public_key_pem,
        public_key_id=public_key_id,
    )

    body = json.loads(body_str)
    resource = body.get("resource", {})

    associated_data = resource.get("associated_data", "")
    resource_nonce = resource.get("nonce", "")
    ciphertext = resource.get("ciphertext", "")
    if not ciphertext:
        raise ValueError("微信支付通知中无加密数据")

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    key = api_v3_key.encode("utf-8")
    nonce_bytes = resource_nonce.encode("utf-8")
    ciphertext_bytes = base64.b64decode(ciphertext)
    aad = associated_data.encode("utf-8") if associated_data else b""
    aesgcm = AESGCM(key)
    decrypted = aesgcm.decrypt(nonce_bytes, ciphertext_bytes, aad)
    return json.loads(decrypted.decode("utf-8"))


async def query_wxpay_order(
    mchid: str,
    out_trade_no: str,
    serial_no: str,
    private_key_pem: str,
    api_v3_key: str = "",
    platform_public_key_pem: str = "",
    platform_public_key_id: str = "",
) -> dict:
    """查询订单状态"""
    url_path = f"/v3/pay/transactions/out-trade-no/{out_trade_no}?mchid={mchid}"
    url = f"{WXPAY_API_BASE}{url_path}"

    auth_token, _, _ = build_authorization_token(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        method="GET",
        url=url_path,
        body="",
    )

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            url,
            headers={"Authorization": auth_token, "Accept": "application/json"},
            timeout=15,
        )
        result = resp.json()

    if resp.status_code != 200:
        raise Exception(f"微信支付查询失败 ({resp.status_code}): {result.get('message', '')}")
    if api_v3_key or platform_public_key_pem:
        verify_platform_signature(
            body_str=resp.text,
            signature=resp.headers.get("Wechatpay-Signature", ""),
            serial_no=resp.headers.get("Wechatpay-Serial", ""),
            timestamp=resp.headers.get("Wechatpay-Timestamp", ""),
            nonce=resp.headers.get("Wechatpay-Nonce", ""),
            public_key_pem=platform_public_key_pem,
            public_key_id=platform_public_key_id,
        )
    return result


async def close_wxpay_order(
    mchid: str,
    out_trade_no: str,
    serial_no: str,
    private_key_pem: str,
) -> bool:
    """关闭订单"""
    url_path = f"/v3/pay/transactions/out-trade-no/{out_trade_no}/close"
    url = f"{WXPAY_API_BASE}{url_path}"

    body = {"mchid": mchid}
    body_str = json.dumps(body, ensure_ascii=False)

    auth_token, _, _ = build_authorization_token(
        mchid=mchid,
        serial_no=serial_no,
        private_key_pem=private_key_pem,
        method="POST",
        url=url_path,
        body=body_str,
    )

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            url,
            headers={
                "Authorization": auth_token,
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            content=body_str,
            timeout=15,
        )
        return resp.status_code == 204
