"""Pure coupon rules shared by API handlers and unit tests."""
from datetime import datetime, timezone


def as_utc(value):
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def mask_phone(phone: str) -> str:
    raw = str(phone or "").strip()
    if len(raw) < 7:
        return raw
    return f"{raw[:3]}****{raw[-4:]}"


def coupon_effective_status(
    status: str,
    valid_until,
    now: datetime | None = None,
) -> str:
    current = now or datetime.now(timezone.utc)
    if status == "used":
        return "used"
    if status == "expired":
        return "expired"
    expiry = as_utc(valid_until)
    if expiry and expiry <= current:
        return "expired"
    if status == "locked":
        return "locked"
    return "unused"


def coupon_discount_for_amount(
    *,
    status: str,
    valid_until,
    discount_type: str,
    discount_value: float,
    min_amount: float,
    amount: float,
    now: datetime | None = None,
) -> tuple[float, str]:
    """Validate a fixed-value mall coupon and calculate its discount."""
    order_amount = round(float(amount or 0), 2)
    if order_amount <= 0:
        return 0.0, "订单金额无效"
    if coupon_effective_status(status, valid_until, now) != "unused":
        return 0.0, "优惠券当前不可用"
    threshold = round(float(min_amount or 0), 2)
    if order_amount < threshold:
        return 0.0, f"满{threshold:g}元可用"
    if (discount_type or "fixed") != "fixed":
        return 0.0, "暂不支持该优惠类型"
    discount = round(float(discount_value or 0), 2)
    if discount <= 0:
        return 0.0, "优惠券已失效"
    # 现有微信支付不接受 0 元订单，抵扣后至少保留 0.01 元。
    discount = min(discount, round(order_amount - 0.01, 2))
    if discount <= 0:
        return 0.0, "订单金额不足"
    return discount, ""
