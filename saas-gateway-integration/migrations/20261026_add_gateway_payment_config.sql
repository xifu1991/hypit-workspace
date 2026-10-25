CREATE TABLE IF NOT EXISTS gateway_payment_configs (
    id INTEGER PRIMARY KEY,
    wxpay_appid VARCHAR(100) NOT NULL DEFAULT '',
    wxpay_mchid VARCHAR(50) NOT NULL DEFAULT '',
    wxpay_api_v3_key VARCHAR(200) NOT NULL DEFAULT '',
    wxpay_key_pem TEXT NOT NULL DEFAULT '',
    wxpay_serial_no VARCHAR(200) NOT NULL DEFAULT '',
    wxpay_public_key_pem TEXT NOT NULL DEFAULT '',
    wxpay_public_key_id VARCHAR(200) NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO gateway_payment_configs (
    id,
    wxpay_appid,
    wxpay_mchid,
    wxpay_api_v3_key,
    wxpay_key_pem,
    wxpay_serial_no
)
SELECT
    1,
    COALESCE(c.miniapp_appid, ''),
    COALESCE(c.wxpay_mchid, ''),
    COALESCE(c.wxpay_api_v3_key, ''),
    COALESCE(c.wxpay_key_pem, ''),
    COALESCE(c.wxpay_serial_no, '')
FROM tenant_miniapp_configs c
JOIN tenants t ON t.id = c.tenant_id
WHERE t.name = '牛莱仕'
ORDER BY c.updated_at DESC NULLS LAST
LIMIT 1
ON CONFLICT (id) DO NOTHING;

INSERT INTO gateway_payment_configs (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;
