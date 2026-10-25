(function () {
  'use strict';

  var PAGE_SIZE = 15;
  var productPage = 1;
  var userPage = 1;
  var orderPage = 1;
  var orderStatusFilter = 'all';
  var editingProductId = '';
  var productImages = [];
  var detailBlocks = [];
  var searchTimer = null;
  var orderSearchTimer = null;
  var orderMap = {};
  var homeBannerImage = '';

  function token() {
    return localStorage.getItem('tenant_token') || '';
  }

  function tokenPayload() {
    try {
      var parts = token().split('.');
      if (parts.length < 2) return {};
      return JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    } catch (_) {
      return {};
    }
  }

  function escHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(value) {
    var n = Number(value || 0);
    return n.toFixed(2);
  }

  async function api(path, options) {
    var headers = Object.assign(
      { 'Content-Type': 'application/json' },
      (options && options.headers) || {}
    );
    if (token() && !headers.Authorization) {
      headers.Authorization = 'Bearer ' + token();
    }
    var response = await fetch(path, Object.assign({}, options || {}, { headers: headers }));
    if (response.status === 401) {
      localStorage.removeItem('tenant_token');
      window.location.href = '/tenant/login';
      throw new Error('登录已过期');
    }
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) {
      throw new Error(data.detail || data.message || ('HTTP ' + response.status));
    }
    return data;
  }

  function setText(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? '—' : value;
  }

  function sectionFromHash() {
    var section = (window.location.hash || '#overview').replace('#', '');
    return ['overview', 'orders', 'products', 'content', 'users', 'settings'].indexOf(section) >= 0
      ? section
      : 'overview';
  }

  function switchSection(section) {
    if (['overview', 'orders', 'products', 'content', 'users', 'settings'].indexOf(section) < 0) {
      section = 'overview';
    }
    document.querySelectorAll('[data-section]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-section') === section);
    });
    document.querySelectorAll('.page-section').forEach(function (el) {
      el.classList.toggle('active', el.id === 'section-' + section);
    });
    var titles = {
      overview: '数据概览',
      orders: '订单管理',
      products: '商品管理',
      content: '内容管理',
      users: '用户管理',
      settings: '设置',
    };
    setText('pageTitle', titles[section] || '菜谱商城');

    var navKey = section === 'overview' ? 'dashboard' : section;
    document.querySelectorAll('.sidebar [data-nav-key]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-nav-key') === navKey);
    });

    if (section === 'overview') loadDashboard();
    if (section === 'orders') loadOrders();
    if (section === 'products') loadProducts();
    if (section === 'users') loadUsers();
    if (section === 'settings') loadSettings();
  }

  async function loadDashboard() {
    try {
      var base = await api('/api/tenant/dashboard');
      setText('statProducts', base.total_products || 0);
    } catch (_) {
      setText('statProducts', '—');
    }

    try {
      var users = await api('/api/tenant/miniapp-users?page=1&page_size=1');
      setText('statUsers', users.total || 0);
    } catch (_) {
      setText('statUsers', '—');
    }

    try {
      var content = await api('/api/apps/xiawazhibo/admin/stats');
      var stats = content.data || content;
      setText('statRecipes', stats.videoCount || 0);
      setText('statViews', Number(stats.totalViews || 0).toLocaleString('zh-CN'));
    } catch (_) {
      setText('statRecipes', '—');
      setText('statViews', '—');
    }
  }

  function orderStatusBadgeClass(statusKey) {
    if (statusKey === 'completed') return 'status-green';
    if (statusKey === 'pending_shipment') return 'status-yellow';
    if (statusKey === 'shipped') return 'status-blue';
    if (statusKey === 'aftersale') return 'status-red';
    return 'status-gray';
  }

  function orderTime(value) {
    if (!value) return '—';
    return String(value).replace('T', ' ').slice(0, 16);
  }

  function orderActionButtons(item) {
    var buttons = [
      '<button class="btn btn-sm btn-outline" type="button" onclick="caipuOrderDetail(\'' + escHtml(item.id) + '\')">详情</button>'
    ];
    if (item.status_key === 'pending_shipment') {
      buttons.push('<button class="btn btn-sm btn-primary" type="button" onclick="caipuOrderAction(\'' + escHtml(item.id) + '\',\'ship\')">标记发货</button>');
    } else if (item.status_key === 'shipped') {
      buttons.push('<button class="btn btn-sm btn-primary" type="button" onclick="caipuOrderAction(\'' + escHtml(item.id) + '\',\'complete\')">确认完成</button>');
    } else if (item.status_key === 'pending_payment') {
      buttons.push('<button class="btn btn-sm btn-danger" type="button" onclick="caipuOrderAction(\'' + escHtml(item.id) + '\',\'cancel\')">取消</button>');
    }
    return '<div class="row-actions">' + buttons.join('') + '</div>';
  }

  async function loadOrderStats() {
    try {
      var stats = await api('/api/tenant/mall-orders/stats');
      var counts = stats.counts || {};
      var summary = stats.summary || {};
      setText('orderStatToday', summary.today_orders || 0);
      setText('orderStatRevenue', '¥' + money(summary.today_revenue));
      setText('orderStatPendingShipment', counts.pending_shipment || 0);
      setText('orderStatAftersale', counts.aftersale || 0);
      setText('orderSummaryTotal', counts.all || 0);
      setText('orderSummaryPaid', summary.paid_orders || 0);
      setText('orderSummaryRevenue', money(summary.total_revenue));
      setText('orderCountAll', counts.all || 0);
      setText('orderCountPendingPayment', counts.pending_payment || 0);
      setText('orderCountPendingShipment', counts.pending_shipment || 0);
      setText('orderCountShipped', counts.shipped || 0);
      setText('orderCountAftersale', counts.aftersale || 0);
      setText('orderCountCompleted', counts.completed || 0);
      setText('orderCountCancelled', counts.cancelled || 0);
    } catch (_) {
      ['orderStatToday', 'orderStatRevenue', 'orderStatPendingShipment', 'orderStatAftersale'].forEach(function (id) {
        setText(id, '—');
      });
    }
  }

  async function loadOrderList() {
    var tbody = document.getElementById('orderTableBody');
    if (!tbody || !token()) return;
    var search = document.getElementById('orderSearch');
    var params = new URLSearchParams({
      status: orderStatusFilter,
      page: String(orderPage),
      page_size: String(PAGE_SIZE),
    });
    if (search && search.value.trim()) params.set('search', search.value.trim());

    try {
      var data = await api('/api/tenant/mall-orders?' + params.toString());
      var items = data.items || [];
      var total = data.total || 0;
      var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (orderPage > totalPages) orderPage = totalPages;
      orderMap = {};
      items.forEach(function (item) { orderMap[item.id] = item; });

      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">当前筛选条件下暂无订单</td></tr>';
      } else {
        tbody.innerHTML = items.map(function (item) {
          var first = (item.items || [])[0] || {};
          var productCell = first.title
            ? (first.cover
              ? '<img class="order-product-thumb" src="' + escHtml(first.cover) + '" alt="">'
              : '<span class="order-product-thumb-empty">品</span>')
            : '<span class="order-product-thumb-empty">—</span>';
          var productCount = Number(item.item_count || 0);
          return '<tr>' +
            '<td><div class="order-number" title="' + escHtml(item.out_trade_no) + '">' + escHtml(item.out_trade_no || item.id) + '</div><div class="order-time">' + escHtml(orderTime(item.created_at)) + '</div></td>' +
            '<td><div class="order-product">' + productCell + '<div><div class="order-product-title">' + escHtml(first.title || '商品信息缺失') + '</div><div class="order-product-meta">共 ' + productCount + ' 件商品</div></div></div></td>' +
            '<td><div class="order-address"><strong>' + escHtml(item.receiver_name || '—') + '</strong>' + escHtml(item.receiver_phone || '—') + '<br>' + escHtml((item.receiver_region || '') + (item.receiver_detail || '')) + '</div></td>' +
            '<td><div class="order-amount">¥' + money(item.final_amount) + '</div></td>' +
            '<td><div class="order-status-stack"><span class="status-badge ' + orderStatusBadgeClass(item.status_key) + '">' + escHtml(item.status_text) + '</span><span class="price-line">' + escHtml(item.payment_status_text) + '</span></div></td>' +
            '<td>' + escHtml(orderTime(item.created_at)) + '</td>' +
            '<td>' + orderActionButtons(item) + '</td>' +
          '</tr>';
        }).join('');
      }

      var pagination = document.getElementById('orderPagination');
      pagination.style.display = totalPages > 1 ? 'flex' : 'none';
      setText('orderPageInfo', '第 ' + orderPage + ' 页 / 共 ' + totalPages + ' 页');
      document.getElementById('orderPrevPage').disabled = orderPage <= 1;
      document.getElementById('orderNextPage').disabled = orderPage >= totalPages;
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">加载失败：' + escHtml(e.message) + '</td></tr>';
    }
  }

  async function loadOrders() {
    await Promise.allSettled([loadOrderStats(), loadOrderList()]);
  }

  function setOrderStatus(status) {
    orderStatusFilter = status || 'all';
    orderPage = 1;
    document.querySelectorAll('[data-order-status]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-order-status') === orderStatusFilter);
    });
    loadOrderList();
  }

  async function updateOrderStatus(id, action) {
    var labels = {
      ship: '确定将该订单标记为已发货？',
      complete: '确定将该订单标记为已完成？',
      cancel: '确定取消该未支付订单？',
    };
    if (!confirm(labels[action] || '确定更新订单状态？')) return;
    try {
      await api('/api/tenant/mall-orders/' + encodeURIComponent(id) + '/' + action, { method: 'POST' });
      await loadOrders();
    } catch (e) {
      alert('操作失败：' + e.message);
    }
  }

  function showOrderDetail(id) {
    var item = orderMap[id];
    if (!item) return;
    var lines = (item.items || []).map(function (line) {
      var cover = line.cover
        ? '<img class="order-product-thumb" src="' + escHtml(line.cover) + '" alt="">'
        : '<span class="order-product-thumb-empty">品</span>';
      return '<div class="order-detail-item">' + cover +
        '<div class="order-detail-item-main"><strong>' + escHtml(line.title || '商品') + '</strong><span>¥' + money(line.price) + ' × ' + Number(line.qty || 1) + '</span></div>' +
        '<strong>¥' + money(Number(line.price || 0) * Number(line.qty || 1)) + '</strong></div>';
    }).join('');
    document.getElementById('orderDetailBody').innerHTML =
      '<div class="order-detail-grid">' +
        '<div class="order-detail-block"><h4>订单信息</h4><p>订单号：' + escHtml(item.out_trade_no || item.id) + '<br>状态：' + escHtml(item.status_text) + '<br>下单：' + escHtml(orderTime(item.created_at)) + '<br>支付：' + escHtml(orderTime(item.paid_at)) + '</p></div>' +
        '<div class="order-detail-block"><h4>收货信息</h4><p>' + escHtml(item.receiver_name || '—') + ' ' + escHtml(item.receiver_phone || '') + '<br>' + escHtml((item.receiver_region || '') + (item.receiver_detail || '')) + '</p></div>' +
      '</div>' +
      '<div class="order-detail-items">' + (lines || '<div class="order-detail-item">商品信息缺失</div>') + '</div>' +
      '<div class="order-detail-total"><span>商品金额 ¥' + money(item.total_amount) + '</span><span>运费 ¥' + money(item.shipping_fee) + '</span><strong>实付 ¥' + money(item.final_amount) + '</strong></div>';
    document.getElementById('orderDetailModal').style.display = 'flex';
  }

  function closeOrderDetail() {
    document.getElementById('orderDetailModal').style.display = 'none';
  }

  function productParams() {
    var search = document.getElementById('productSearch');
    var params = new URLSearchParams({
      page: String(productPage),
      page_size: String(PAGE_SIZE),
    });
    if (search && search.value.trim()) params.set('search', search.value.trim());
    return params.toString();
  }

  async function loadProducts() {
    var tbody = document.getElementById('productTableBody');
    if (!tbody || !token()) return;
    try {
      var data = await api('/api/tenant/products?' + productParams());
      var items = data.items || [];
      var total = data.total || 0;
      var totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (productPage > totalPages) productPage = totalPages;
      setText('productSummaryCount', total);

      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="table-empty">暂无商城商品，点击右上角新增</td></tr>';
      } else {
        tbody.innerHTML = items.map(function (p) {
          var thumb = p.image_url
            ? '<img class="product-thumb" src="' + escHtml(p.image_url) + '" alt="">'
            : '<span class="product-thumb-empty">无图</span>';
          var status = p.is_active
            ? '<span class="status-badge status-green">上架</span>'
            : '<span class="status-badge status-gray">下架</span>';
          return '<tr>' +
            '<td>' + thumb + '</td>' +
            '<td><div class="product-name">' + escHtml(p.name) + '</div></td>' +
            '<td><s class="price-line">¥' + money(p.original_price) + '</s></td>' +
            '<td><strong class="product-amount">¥' + money(p.special_price) + '</strong></td>' +
            '<td><span class="sales-count">' + (p.sales_count || 0) + '</span></td>' +
            '<td>' + status + '</td>' +
            '<td><div class="row-actions">' +
              '<button class="btn btn-sm btn-outline" onclick="caipuEditProduct(\'' + escHtml(p.id) + '\')">编辑</button>' +
              '<button class="btn btn-sm btn-danger" onclick="caipuDeleteProduct(\'' + escHtml(p.id) + '\')">删除</button>' +
            '</div></td>' +
          '</tr>';
        }).join('');
      }

      var pagination = document.getElementById('productPagination');
      pagination.style.display = totalPages > 1 ? 'flex' : 'none';
      setText('productPageInfo', '第 ' + productPage + ' 页 / 共 ' + totalPages + ' 页');
      document.getElementById('productPrevPage').disabled = productPage <= 1;
      document.getElementById('productNextPage').disabled = productPage >= totalPages;
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="7" class="table-empty">加载失败：' + escHtml(e.message) + '</td></tr>';
    }
  }

  function normalizeImages(list) {
    var result = [];
    (Array.isArray(list) ? list : []).forEach(function (url) {
      var value = String(url || '').trim();
      if (value && result.indexOf(value) < 0 && result.length < 9) result.push(value);
    });
    return result;
  }

  function setImageStatus(statusText, statusType) {
    var status = document.getElementById('pfImageStatus');
    if (status) {
      status.textContent = statusText || '';
      status.style.color = statusType === 'error' ? 'var(--destructive)' : (statusType === 'success' ? 'var(--success)' : 'var(--muted-fg)');
    }
  }

  function renderProductImages(statusText, statusType) {
    var gallery = document.getElementById('pfImageGallery');
    if (!gallery) return;
    if (!productImages.length) {
      gallery.innerHTML = '<div class="image-gallery-empty">还没有图片，上传后第一张自动作为封面</div>';
    } else {
      gallery.innerHTML = productImages.map(function (url, index) {
        return '<div class="image-item">' +
          '<img src="' + escHtml(url) + '" alt="商品图片">' +
          (index === 0 ? '<span class="image-item-cover">封面</span>' : '') +
          '<div class="image-item-actions">' +
            (index > 0 ? '<button type="button" onclick="caipuSetCoverImage(' + index + ')">设为封面</button>' : '') +
            '<button type="button" onclick="caipuRemoveImage(' + index + ')">删除</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }
    setImageStatus(statusText || (productImages.length ? '已添加 ' + productImages.length + ' 张，保存后小程序生效' : ''), statusType);
  }

  function setProductImages(list, statusText, statusType) {
    productImages = normalizeImages(list);
    renderProductImages(statusText, statusType);
  }

  function addProductImage(url) {
    var value = String(url || '').trim();
    if (!value) return false;
    if (productImages.indexOf(value) >= 0) {
      setImageStatus('这张图片已经在图集里了', 'error');
      return false;
    }
    if (productImages.length >= 9) {
      setImageStatus('最多只能添加 9 张图片', 'error');
      return false;
    }
    productImages.push(value);
    renderProductImages('已添加图片，保存后小程序生效', 'success');
    return true;
  }

  async function uploadProductImages(fileInput) {
    var files = Array.prototype.slice.call((fileInput && fileInput.files) || []);
    if (!files.length) return;
    var uploaded = 0;
    setImageStatus('上传中…', 'normal');
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      if (file.size > 5 * 1024 * 1024) {
        setImageStatus(file.name + ' 超过 5MB，已跳过', 'error');
        continue;
      }
      if (productImages.length >= 9) {
        setImageStatus('最多只能添加 9 张图片', 'error');
        break;
      }
      var form = new FormData();
      form.append('file', file);
      try {
        var response = await fetch('/api/tenant/products/upload-image', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token() },
          body: form,
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) throw new Error(data.detail || '上传失败');
        if (addProductImage(data.url || data.image_url || '')) uploaded += 1;
      } catch (e) {
        setImageStatus(e.message, 'error');
      }
    }
    fileInput.value = '';
    if (uploaded) setImageStatus('上传成功 ' + uploaded + ' 张，保存后小程序生效', 'success');
  }

  function detailTextBlock(text) {
    return { type: 'text', text: String(text == null ? '' : text) };
  }

  function detailImageBlock(url) {
    return { type: 'image', url: String(url || '') };
  }

  function legacyDetailText(html) {
    var node = document.createElement('div');
    node.innerHTML = String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
    var text = node.textContent || node.innerText || '';
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function legacyHtmlToDetailBlocks(html) {
    var source = String(html || '');
    var imageRe = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    var blocks = [];
    var lastIndex = 0;
    var match;
    while ((match = imageRe.exec(source)) !== null) {
      var text = legacyDetailText(source.slice(lastIndex, match.index));
      if (text) blocks.push(detailTextBlock(text));
      var url = String(match[1] || match[2] || match[3] || '').trim();
      if (url) blocks.push(detailImageBlock(url));
      lastIndex = imageRe.lastIndex;
    }
    var tail = legacyDetailText(source.slice(lastIndex));
    if (tail) blocks.push(detailTextBlock(tail));
    return blocks.length ? blocks : [detailTextBlock('')];
  }

  function normalizeDetailBlocks(raw) {
    var value = String(raw == null ? '' : raw).trim();
    if (!value) return [detailTextBlock('')];
    if (value.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          var blocks = parsed.map(function (item) {
            if (!item || typeof item !== 'object') return null;
            var type = String(item.type || '').toLowerCase();
            if (type === 'image') {
              var url = String(item.url || '').trim();
              return url ? detailImageBlock(url) : null;
            }
            var text = String(item.text == null ? '' : item.text);
            return text.trim() ? detailTextBlock(text) : null;
          }).filter(function (item) { return !!item; });
          return blocks.length ? blocks : [detailTextBlock('')];
        }
      } catch (_) {
        // 旧详情只要不是有效 JSON，就继续按纯文本或 HTML 解析。
      }
    }
    if (/<img\b/i.test(value)) return legacyHtmlToDetailBlocks(value);
    return [detailTextBlock(value)];
  }

  function compactDetailBlocks() {
    return detailBlocks.map(function (block) {
      if (block.type === 'image') {
        var url = String(block.url || '').trim();
        return url ? detailImageBlock(url) : null;
      }
      var text = String(block.text || '').trim();
      return text ? detailTextBlock(text) : null;
    }).filter(function (block) { return !!block; });
  }

  function packageDetailsPayload() {
    var blocks = compactDetailBlocks();
    if (!blocks.length) return '';
    if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
    return JSON.stringify(blocks);
  }

  function renderDetailEditor(statusText, statusType) {
    var host = document.getElementById('pfDetailEditor');
    if (!host) return;
    if (!detailBlocks.length) detailBlocks = [detailTextBlock('')];
    host.innerHTML = detailBlocks.map(function (block, index) {
      var isImage = block.type === 'image';
      var label = isImage ? '图片' : '文字段落';
      var actions = '<div class="detail-block-actions">' +
        '<button class="detail-action" type="button" ' + (index === 0 ? 'disabled' : '') + ' onclick="caipuMoveDetailBlock(' + index + ', -1)">上移</button>' +
        '<button class="detail-action" type="button" ' + (index === detailBlocks.length - 1 ? 'disabled' : '') + ' onclick="caipuMoveDetailBlock(' + index + ', 1)">下移</button>' +
        '<button class="detail-action detail-action-danger" type="button" onclick="caipuRemoveDetailBlock(' + index + ')">删除</button>' +
      '</div>';
      var body = '';
      if (isImage) {
        var url = String(block.url || '');
        body = '<div class="detail-image-preview">' +
            (url ? '<img src="' + escHtml(url) + '" alt="详情图片">' : '<span>暂无图片，可上传或粘贴图片链接</span>') +
          '</div>' +
          '<div class="detail-image-controls">' +
            '<input type="file" id="pfDetailImageFile' + index + '" accept="image/*" style="display:none;" onchange="caipuUploadDetailImage(this, ' + index + ')">' +
            '<button class="btn btn-sm btn-outline" type="button" onclick="caipuPickDetailImage(' + index + ')">上传图片</button>' +
            '<input class="form-input detail-image-url" type="text" value="' + escHtml(url) + '" placeholder="或粘贴图片 URL 后移出输入框" onchange="caipuSetDetailImageUrl(' + index + ', this.value)">' +
          '</div>';
      } else {
        body = '<textarea class="form-input detail-textarea" rows="4" placeholder="输入商品卖点、规格或使用说明…" oninput="caipuUpdateDetailText(' + index + ', this.value)">' + escHtml(block.text || '') + '</textarea>';
      }
      return '<div class="detail-block">' +
        '<div class="detail-block-head"><span class="detail-block-label">' + label + '</span>' + actions + '</div>' +
        body +
      '</div>';
    }).join('');
    var status = document.getElementById('pfDetailStatus');
    if (status) {
      status.textContent = statusText || '';
      status.style.color = statusType === 'error' ? 'var(--destructive)' : (statusType === 'success' ? 'var(--success)' : 'var(--muted-light)');
    }
  }

  async function uploadDetailImage(input, index) {
    var file = input && input.files && input.files[0];
    if (!file || !detailBlocks[index]) return;
    if (file.size > 5 * 1024 * 1024) {
      renderDetailEditor('图片不能超过 5MB', 'error');
      input.value = '';
      return;
    }
    var form = new FormData();
    form.append('file', file);
    renderDetailEditor('图片上传中…', 'normal');
    try {
      var response = await fetch('/api/tenant/products/upload-image', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token() },
        body: form,
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '上传失败');
      detailBlocks[index] = detailImageBlock(data.url || data.image_url || '');
      renderDetailEditor('图片上传成功，保存后小程序生效', 'success');
    } catch (e) {
      renderDetailEditor(e.message, 'error');
    } finally {
      input.value = '';
    }
  }

  // ── 商品规格编辑 ──
  var SPEC_GROUP_MAX = 5;
  var SPEC_OPTION_MAX = 20;
  var specGroups = [];

  function toSpecPrice(value) {
    var n = parseFloat(value);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100) / 100;
  }

  function normalizeSpecGroups(raw) {
    if (!Array.isArray(raw)) return [];
    var groups = [];
    raw.forEach(function (group) {
      if (groups.length >= SPEC_GROUP_MAX || !group || typeof group !== 'object') return;
      var name = String(group.name || '').trim();
      if (!name) return;
      var options = [];
      (Array.isArray(group.options) ? group.options : []).forEach(function (option) {
        if (options.length >= SPEC_OPTION_MAX || !option || typeof option !== 'object') return;
        var label = String(option.label || '').trim();
        if (!label) return;
        options.push({
          label: label,
          price: toSpecPrice(option.price),
          original_price: toSpecPrice(option.original_price),
          image: String(option.image || '').trim(),
        });
      });
      if (!options.length) return;
      groups.push({ name: name, options: options });
    });
    return groups;
  }

  // 只在增删规格组/选项时整体重绘；输入框改动只写数据，避免光标丢失
  function renderSpecEditor() {
    var box = document.getElementById('pfSpecEditor');
    if (!box) return;
    if (!specGroups.length) {
      box.innerHTML = '<div class="spec-empty">暂无规格。不设置时小程序按商品默认价直接下单</div>';
      return;
    }
    box.innerHTML = specGroups.map(function (group, gi) {
      var options = group.options.map(function (option, oi) {
        var thumb = option.image
          ? '<img class="spec-option-thumb-img" src="' + escHtml(option.image) + '" alt="">'
          : '<span class="spec-option-thumb-hint">图</span>';
        return '<div class="spec-option">' +
          '<div class="spec-option-thumb" title="上传选项图片" onclick="document.getElementById(\'pfSpecImageFile' + gi + '_' + oi + '\').click()">' +
            thumb +
            (option.image ? '<button class="spec-option-thumb-clear" type="button" title="移除图片" onclick="event.stopPropagation();caipuClearSpecImage(' + gi + ',' + oi + ')">✕</button>' : '') +
          '</div>' +
          '<input type="file" id="pfSpecImageFile' + gi + '_' + oi + '" accept="image/*" style="display:none;" onchange="caipuUploadSpecImage(' + gi + ',' + oi + ',this)">' +
          '<input class="form-input spec-option-label" type="text" placeholder="选项名称，如 1000克 6-8块" value="' + escHtml(option.label) + '" oninput="caipuSpecOptionLabel(' + gi + ',' + oi + ',this.value)">' +
          '<input class="form-input spec-option-price" type="number" min="0" step="0.01" placeholder="价格" value="' + (option.price ? option.price : '') + '" oninput="caipuSpecOptionPrice(' + gi + ',' + oi + ',this.value)">' +
          '<input class="form-input spec-option-origin" type="number" min="0" step="0.01" placeholder="划线价" value="' + (option.original_price ? option.original_price : '') + '" oninput="caipuSpecOptionOrigin(' + gi + ',' + oi + ',this.value)">' +
          '<button class="detail-action detail-action-danger" type="button" onclick="caipuRemoveSpecOption(' + gi + ',' + oi + ')">删除</button>' +
          '</div>';
      }).join('');
      return '<div class="spec-group">' +
        '<div class="spec-group-head">' +
          '<input class="form-input" type="text" placeholder="规格组名称，如 总净重" value="' + escHtml(group.name) + '" oninput="caipuSpecGroupName(' + gi + ',this.value)">' +
          '<button class="detail-action detail-action-danger" type="button" onclick="caipuRemoveSpecGroup(' + gi + ')">删除组</button>' +
        '</div>' +
        '<div class="spec-options">' + options + '</div>' +
        '<button class="btn btn-sm btn-outline spec-add-option" type="button" onclick="caipuAddSpecOption(' + gi + ')">+ 添加选项</button>' +
        '</div>';
    }).join('');
  }

  function caipuSpecGroupName(gi, value) {
    if (specGroups[gi]) specGroups[gi].name = value;
  }

  function caipuSpecOptionLabel(gi, oi, value) {
    if (specGroups[gi] && specGroups[gi].options[oi]) specGroups[gi].options[oi].label = value;
  }

  function caipuSpecOptionPrice(gi, oi, value) {
    if (specGroups[gi] && specGroups[gi].options[oi]) specGroups[gi].options[oi].price = toSpecPrice(value);
  }

  function caipuSpecOptionOrigin(gi, oi, value) {
    if (specGroups[gi] && specGroups[gi].options[oi]) specGroups[gi].options[oi].original_price = toSpecPrice(value);
  }

  function setSpecStatus(message, statusType) {
    var status = document.getElementById('pfSpecStatus');
    if (!status) return;
    status.textContent = message || '';
    status.style.color = statusType === 'error' ? 'var(--destructive)' : (statusType === 'success' ? 'var(--success)' : 'var(--muted-light)');
  }

  // 规格选项图片：小程序弹窗里显示该选项的小图（不传则回退商品主图）
  async function caipuUploadSpecImage(gi, oi, input) {
    var option = specGroups[gi] && specGroups[gi].options[oi];
    var file = input && input.files && input.files[0];
    if (!option || !file) return;
    if (file.size > 5 * 1024 * 1024) {
      setSpecStatus('图片不能超过 5MB', 'error');
      input.value = '';
      return;
    }
    var form = new FormData();
    form.append('file', file);
    setSpecStatus('图片上传中…', 'normal');
    try {
      var response = await fetch('/api/tenant/products/upload-image', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token() },
        body: form,
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '上传失败');
      option.image = data.url || data.image_url || '';
      renderSpecEditor();
      setSpecStatus('图片上传成功，保存后小程序生效', 'success');
    } catch (e) {
      setSpecStatus(e.message, 'error');
    } finally {
      input.value = '';
    }
  }

  function caipuClearSpecImage(gi, oi) {
    if (specGroups[gi] && specGroups[gi].options[oi]) specGroups[gi].options[oi].image = '';
    renderSpecEditor();
  }

  function caipuAddSpecGroup() {
    if (specGroups.length >= SPEC_GROUP_MAX) {
      alert('最多 ' + SPEC_GROUP_MAX + ' 个规格组');
      return;
    }
    specGroups.push({ name: '', options: [{ label: '', price: 0, original_price: 0, image: '' }] });
    renderSpecEditor();
  }

  function caipuRemoveSpecGroup(gi) {
    specGroups.splice(gi, 1);
    renderSpecEditor();
  }

  function caipuAddSpecOption(gi) {
    var group = specGroups[gi];
    if (!group) return;
    if (group.options.length >= SPEC_OPTION_MAX) {
      alert('每组最多 ' + SPEC_OPTION_MAX + ' 个选项');
      return;
    }
    group.options.push({ label: '', price: 0, original_price: 0, image: '' });
    renderSpecEditor();
  }

  function caipuRemoveSpecOption(gi, oi) {
    var group = specGroups[gi];
    if (!group) return;
    group.options.splice(oi, 1);
    renderSpecEditor();
  }

  function collectSpecs() {
    return specGroups
      .map(function (group) {
        return {
          name: String(group.name || '').trim(),
          options: (group.options || [])
            .map(function (option) {
              return {
                label: String(option.label || '').trim(),
                price: toSpecPrice(option.price),
                original_price: toSpecPrice(option.original_price),
                image: String(option.image || '').trim(),
              };
            })
            .filter(function (option) { return !!option.label; }),
        };
      })
      .filter(function (group) { return !!group.name && group.options.length; });
  }

  function showProductForm(product) {
    var p = product || {};
    editingProductId = p.id || '';
    document.getElementById('productFormTitle').textContent = editingProductId ? '编辑商品' : '新增商品';
    document.getElementById('pfName').value = p.name || '';
    document.getElementById('pfOriginal').value = p.original_price || '';
    document.getElementById('pfSpecial').value = p.special_price || '';
    document.getElementById('pfSalesCount').value = p.sales_count || 0;
    document.getElementById('pfSortOrder').value = p.sort_order || 0;
    detailBlocks = normalizeDetailBlocks(p.package_details || '');
    renderDetailEditor('', 'normal');
    specGroups = normalizeSpecGroups(p.specs);
    renderSpecEditor();
    document.getElementById('pfActive').checked = p.is_active !== false;
    document.getElementById('pfImageUrl').value = '';
    setProductImages(p.images && p.images.length ? p.images : (p.image_url ? [p.image_url] : []), '');
    document.getElementById('productFormModal').style.display = 'flex';
  }

  async function editProduct(id) {
    try {
      var p = await api('/api/tenant/products/' + encodeURIComponent(id));
      showProductForm(p);
    } catch (e) {
      alert('加载商品失败：' + e.message);
    }
  }

  async function saveProduct() {
    var name = document.getElementById('pfName').value.trim();
    if (!name) {
      alert('请输入商品名称');
      return;
    }
    var specs = collectSpecs();
    if (specGroups.length && specs.length !== specGroups.length) {
      alert('每个规格组都要填名称，且至少保留一个填了选项名称的选项');
      return;
    }
    var data = {
      name: name,
      original_price: parseFloat(document.getElementById('pfOriginal').value) || 0,
      special_price: parseFloat(document.getElementById('pfSpecial').value) || 0,
      sales_count: parseInt(document.getElementById('pfSalesCount').value, 10) || 0,
      sort_order: parseInt(document.getElementById('pfSortOrder').value, 10) || 0,
      image_url: productImages[0] || '',
      images: productImages,
      specs: specs,
      package_details: packageDetailsPayload(),
      is_active: document.getElementById('pfActive').checked,
    };
    var path = editingProductId
      ? '/api/tenant/products/' + encodeURIComponent(editingProductId)
      : '/api/tenant/products';
    var method = editingProductId ? 'PUT' : 'POST';
    var button = document.getElementById('productSaveBtn');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api(path, { method: method, body: JSON.stringify(data) });
      closeProductForm();
      loadProducts();
    } catch (e) {
      alert('保存失败：' + e.message);
    } finally {
      button.disabled = false;
      button.textContent = '保存';
    }
  }

  async function deleteProduct(id) {
    if (!confirm('确定删除这个商城商品？删除后小程序商城将不再显示。')) return;
    try {
      await api('/api/tenant/products/' + encodeURIComponent(id), { method: 'DELETE' });
      loadProducts();
    } catch (e) {
      alert('删除失败：' + e.message);
    }
  }

  function closeProductForm() {
    document.getElementById('productFormModal').style.display = 'none';
    editingProductId = '';
  }

  async function loadUsers() {
    var tbody = document.getElementById('userTableBody');
    if (!tbody || !token()) return;
    try {
      var search = document.getElementById('userSearch');
      var params = new URLSearchParams({
        page: String(userPage),
        page_size: '15',
      });
      if (search && search.value.trim()) params.set('search', search.value.trim());
      var data = await api('/api/tenant/miniapp-users?' + params.toString());
      var items = data.items || [];
      setText('userSummaryCount', data.total || 0);
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="table-empty">暂无小程序用户</td></tr>';
        return;
      }
      tbody.innerHTML = items.map(function (u) {
        var avatar = u.avatar_url
          ? '<img class="user-avatar" src="' + escHtml(u.avatar_url) + '" alt="">'
          : '<span class="user-avatar user-avatar-empty">' + escHtml((u.nickname || '用').slice(0, 1)) + '</span>';
        return '<tr>' +
          '<td><div class="user-cell">' + avatar + '<span>' + escHtml(u.nickname || '微信用户') + '</span></div></td>' +
          '<td class="mono-cell">' + escHtml(u.openid || '—') + '</td>' +
          '<td>' + escHtml(u.phone || '—') + '</td>' +
          '<td>' + escHtml((u.created_at || '').replace('T', ' ').slice(0, 16) || '—') + '</td>' +
          '<td>' + escHtml(u.address || '—') + '</td>' +
        '</tr>';
      }).join('');
    } catch (e) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">加载失败：' + escHtml(e.message) + '</td></tr>';
    }
  }

  async function loadMiniConfig() {
    try {
      var data = await api('/api/tenant/miniapp-config');
      document.getElementById('miniAppId').value = data.app_id || '';
      var secret = document.getElementById('miniAppSecret');
      secret.value = '';
      secret.placeholder = data.app_secret ? '已配置，留空不修改' : '请输入小程序 AppSecret';
      document.getElementById('miniPublished').checked = !!data.is_published;
      setText('miniConfigStatus', '');
      setConfigBadge('miniConfigBadge', !!data.app_id, !!data.app_secret, '已配置', '待完善');
      homeBannerImage = data.home_banner_image || '';
      renderHomeBanner();
    } catch (e) {
      setText('miniConfigStatus', '配置加载失败：' + e.message);
      setConfigBadge('miniConfigBadge', false, false, '已配置', '读取失败');
    }
  }

  function setConfigBadge(id, primaryReady, secretReady, readyText, pendingText) {
    var badge = document.getElementById(id);
    if (!badge) return;
    badge.className = 'status-badge ' + (primaryReady && secretReady ? 'status-green' : 'status-yellow');
    badge.textContent = primaryReady && secretReady ? readyText : pendingText;
  }

  function setSecretPlaceholder(id, configured, placeholder) {
    var el = document.getElementById(id);
    if (!el) return;
    el.value = '';
    el.placeholder = configured ? '已配置，留空不修改' : placeholder;
  }

  async function loadWxpayConfig() {
    try {
      var data = await api('/api/tenant/wxpay-config');
      document.getElementById('wxpayMchid').value = data.wxpay_mchid || '';
      document.getElementById('wxpaySerialNo').value = data.wxpay_serial_no || '';
      document.getElementById('wxpayNotifyUrl').value = data.wxpay_notify_url || '';
      setSecretPlaceholder('wxpayApiV3Key', data.wxpay_api_v3_key === '****', '32位密钥');
      setSecretPlaceholder('wxpayPrivateKey', data.wxpay_key_pem === '****', 'apiclient_key.pem 文件内容');
      setSecretPlaceholder('wxpayCertPem', data.wxpay_cert_pem === '****', 'apiclient_cert.pem 文件内容');

      setText('wxpayCheckAppid', data.miniapp_appid || '未配置');
      setText('wxpayCheckReady', data.has_config ? '已就绪' : '待完善');
      setConfigBadge('wxpayConfigBadge', !!data.has_config, true, '已就绪', '待完善');
      setText('wxpayConfigStatus', '');
    } catch (e) {
      setText('wxpayConfigStatus', '配置加载失败：' + e.message);
      setConfigBadge('wxpayConfigBadge', false, false, '已就绪', '读取失败');
    }
  }

  function loadSettings() {
    loadMiniConfig();
    loadWxpayConfig();
  }

  async function saveMiniConfig() {
    var appId = document.getElementById('miniAppId').value.trim();
    var appSecret = document.getElementById('miniAppSecret').value.trim();
    var published = document.getElementById('miniPublished').checked;
    var status = document.getElementById('miniConfigStatus');
    var button = document.getElementById('miniConfigSaveBtn');
    var body = { app_id: appId, is_published: published };
    if (appSecret) body.app_secret = appSecret;
    button.disabled = true;
    button.textContent = '保存中…';
    if (status) {
      status.textContent = '保存中…';
      status.style.color = 'var(--muted-fg)';
    }
    try {
      await api('/api/tenant/miniapp-config', { method: 'PUT', body: JSON.stringify(body) });
      await loadMiniConfig();
      await loadWxpayConfig();
      if (status) {
        status.textContent = '保存成功';
        status.style.color = 'var(--success)';
      }
    } catch (e) {
      if (status) {
        status.textContent = '保存失败：' + e.message;
        status.style.color = 'var(--destructive)';
      }
    } finally {
      button.disabled = false;
      button.textContent = '保存配置';
    }
  }

  // ── 首页 Banner 图片 ──
  function renderHomeBanner() {
    var preview = document.getElementById('homeBannerPreview');
    var badge = document.getElementById('homeBannerBadge');
    var removeBtn = document.getElementById('homeBannerRemoveBtn');
    if (!preview) return;
    if (homeBannerImage) {
      preview.innerHTML = '<img src="' + escHtml(homeBannerImage) + '" alt="首页 Banner">';
      if (badge) { badge.className = 'status-badge status-green'; badge.textContent = '已设置'; }
      if (removeBtn) removeBtn.disabled = false;
    } else {
      preview.innerHTML = '<span>暂无图片</span>';
      if (badge) { badge.className = 'status-badge status-gray'; badge.textContent = '未设置'; }
      if (removeBtn) removeBtn.disabled = true;
    }
  }

  async function persistHomeBanner(url) {
    var status = document.getElementById('homeBannerStatus');
    if (status) {
      status.textContent = '保存中…';
      status.style.color = 'var(--muted-fg)';
    }
    try {
      await api('/api/tenant/miniapp-config', {
        method: 'PUT',
        body: JSON.stringify({ home_banner_image: url || '' }),
      });
      homeBannerImage = url || '';
      renderHomeBanner();
      if (status) {
        status.textContent = homeBannerImage ? '已保存，小程序首页同步生效' : '已移除，小程序恢复默认 Banner';
        status.style.color = 'var(--success)';
      }
      return true;
    } catch (e) {
      if (status) {
        status.textContent = '保存失败：' + e.message;
        status.style.color = 'var(--destructive)';
      }
      return false;
    }
  }

  async function uploadHomeBanner(fileInput) {
    var files = (fileInput && fileInput.files) || [];
    if (!files.length) return;
    var file = files[0];
    var status = document.getElementById('homeBannerStatus');
    if (file.size > 5 * 1024 * 1024) {
      if (status) { status.textContent = '图片超过 5MB'; status.style.color = 'var(--destructive)'; }
      fileInput.value = '';
      return;
    }
    if (status) { status.textContent = '上传中…'; status.style.color = 'var(--muted-fg)'; }
    var form = new FormData();
    form.append('file', file);
    try {
      var response = await fetch('/api/tenant/products/upload-image', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token() },
        body: form,
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.detail || '上传失败');
      await persistHomeBanner(data.url || data.image_url || '');
    } catch (e) {
      if (status) { status.textContent = '上传失败：' + e.message; status.style.color = 'var(--destructive)'; }
    } finally {
      fileInput.value = '';
    }
  }

  function removeHomeBanner() {
    if (!homeBannerImage) return;
    persistHomeBanner('');
  }

  async function saveWxpayConfig() {
    var button = document.getElementById('wxpayConfigSaveBtn');
    var status = document.getElementById('wxpayConfigStatus');
    var payload = {};
    var fields = [
      ['wxpayMchid', 'wxpay_mchid'],
      ['wxpayApiV3Key', 'wxpay_api_v3_key'],
      ['wxpaySerialNo', 'wxpay_serial_no'],
      ['wxpayPrivateKey', 'wxpay_key_pem'],
      ['wxpayCertPem', 'wxpay_cert_pem'],
      ['wxpayNotifyUrl', 'wxpay_notify_url'],
    ];
    fields.forEach(function (pair) {
      var input = document.getElementById(pair[0]);
      var value = input ? input.value.trim() : '';
      if (value && value !== '****') payload[pair[1]] = value;
    });

    if (!Object.keys(payload).length) {
      if (status) {
        status.textContent = '请先填写需要保存的支付配置';
        status.style.color = 'var(--warning)';
      }
      return;
    }

    button.disabled = true;
    button.textContent = '保存中…';
    if (status) {
      status.textContent = '保存中…';
      status.style.color = 'var(--muted-fg)';
    }
    try {
      await api('/api/tenant/wxpay-config', { method: 'PUT', body: JSON.stringify(payload) });
      await loadWxpayConfig();
      if (status) {
        status.textContent = '保存成功';
        status.style.color = 'var(--success)';
      }
    } catch (e) {
      if (status) {
        status.textContent = '保存失败：' + e.message;
        status.style.color = 'var(--destructive)';
      }
    } finally {
      button.disabled = false;
      button.textContent = '保存支付配置';
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-section]').forEach(function (el) {
      el.addEventListener('click', function (event) {
        event.preventDefault();
        var section = el.getAttribute('data-section');
        history.replaceState(null, '', '#' + section);
        switchSection(section);
      });
    });

    var productSearch = document.getElementById('productSearch');
    if (productSearch) {
      productSearch.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () {
          productPage = 1;
          loadProducts();
        }, 300);
      });
    }

    var userSearch = document.getElementById('userSearch');
    if (userSearch) {
      userSearch.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          userPage = 1;
          loadUsers();
        }
      });
    }

    var orderSearch = document.getElementById('orderSearch');
    if (orderSearch) {
      orderSearch.addEventListener('input', function () {
        clearTimeout(orderSearchTimer);
        orderSearchTimer = setTimeout(function () {
          orderPage = 1;
          loadOrderList();
        }, 300);
      });
    }

    window.addEventListener('hashchange', function () {
      switchSection(sectionFromHash());
    });
  }

  window.caipuShowProductForm = function (product) { showProductForm(product || null); };
  window.caipuEditProduct = editProduct;
  window.caipuSaveProduct = saveProduct;
  window.caipuDeleteProduct = deleteProduct;
  window.caipuCloseProductForm = closeProductForm;
  window.caipuUploadImages = uploadProductImages;
  window.caipuAddDetailText = function () {
    detailBlocks.push(detailTextBlock(''));
    renderDetailEditor('已添加文字段落', 'normal');
  };
  window.caipuAddDetailImage = function () {
    detailBlocks.push(detailImageBlock(''));
    renderDetailEditor('可上传图片或粘贴图片链接', 'normal');
    window.caipuPickDetailImage(detailBlocks.length - 1);
  };
  window.caipuPickDetailImage = function (index) {
    var input = document.getElementById('pfDetailImageFile' + index);
    if (input) input.click();
  };
  window.caipuUploadDetailImage = uploadDetailImage;
  window.caipuUpdateDetailText = function (index, value) {
    if (detailBlocks[index]) detailBlocks[index].text = value;
  };
  window.caipuSetDetailImageUrl = function (index, value) {
    if (!detailBlocks[index]) return;
    detailBlocks[index].url = String(value || '').trim();
    renderDetailEditor(detailBlocks[index].url ? '图片链接已更新，保存后小程序生效' : '', 'normal');
  };
  window.caipuMoveDetailBlock = function (index, delta) {
    var target = index + delta;
    if (index < 0 || index >= detailBlocks.length || target < 0 || target >= detailBlocks.length) return;
    var block = detailBlocks.splice(index, 1)[0];
    detailBlocks.splice(target, 0, block);
    renderDetailEditor('详情顺序已调整', 'normal');
  };
  window.caipuRemoveDetailBlock = function (index) {
    if (index < 0 || index >= detailBlocks.length) return;
    detailBlocks.splice(index, 1);
    renderDetailEditor('已删除详情内容块', 'normal');
  };
  window.caipuClearDetailBlocks = function () {
    if (!confirm('确定清空商品详情吗？')) return;
    detailBlocks = [detailTextBlock('')];
    renderDetailEditor('商品详情已清空', 'normal');
  };
  window.caipuAddImageUrl = function () {
    var input = document.getElementById('pfImageUrl');
    if (!input) return;
    if (addProductImage(input.value)) input.value = '';
  };
  window.caipuRemoveImage = function (index) {
    if (index < 0 || index >= productImages.length) return;
    productImages.splice(index, 1);
    renderProductImages('已删除图片，保存后生效', 'success');
  };
  window.caipuSetCoverImage = function (index) {
    if (index <= 0 || index >= productImages.length) return;
    var url = productImages.splice(index, 1)[0];
    productImages.unshift(url);
    renderProductImages('已设为封面，保存后生效', 'success');
  };
  window.caipuClearImage = function () {
    setProductImages([], '已清除图片，保存后生效', 'success');
  };
  window.caipuProductPrev = function () {
    if (productPage > 1) {
      productPage -= 1;
      loadProducts();
    }
  };
  window.caipuProductNext = function () {
    productPage += 1;
    loadProducts();
  };
  window.caipuUserSearch = function () {
    userPage = 1;
    loadUsers();
  };
  window.caipuOrderStatus = setOrderStatus;
  window.caipuOrderPrev = function () {
    if (orderPage > 1) {
      orderPage -= 1;
      loadOrderList();
    }
  };
  window.caipuOrderNext = function () {
    orderPage += 1;
    loadOrderList();
  };
  window.caipuOrderAction = updateOrderStatus;
  window.caipuOrderDetail = showOrderDetail;
  window.caipuCloseOrderDetail = closeOrderDetail;
  window.caipuRefreshOrders = loadOrders;
  window.caipuSaveMiniConfig = saveMiniConfig;
  window.caipuSaveWxpayConfig = saveWxpayConfig;
  window.caipuUploadHomeBanner = uploadHomeBanner;
  window.caipuRemoveHomeBanner = removeHomeBanner;
  window.caipuAddSpecGroup = caipuAddSpecGroup;
  window.caipuRemoveSpecGroup = caipuRemoveSpecGroup;
  window.caipuAddSpecOption = caipuAddSpecOption;
  window.caipuRemoveSpecOption = caipuRemoveSpecOption;
  window.caipuSpecGroupName = caipuSpecGroupName;
  window.caipuSpecOptionLabel = caipuSpecOptionLabel;
  window.caipuSpecOptionPrice = caipuSpecOptionPrice;
  window.caipuSpecOptionOrigin = caipuSpecOptionOrigin;
  window.caipuUploadSpecImage = caipuUploadSpecImage;
  window.caipuClearSpecImage = caipuClearSpecImage;
  window.caipuLogout = function () {
    localStorage.removeItem('tenant_token');
    localStorage.removeItem('tenant_profile');
    document.cookie = 'tenant_token=; path=/; max-age=0';
    window.location.href = '/tenant/login';
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (!token()) {
      window.location.href = '/tenant/login';
      return;
    }
    var payload = tokenPayload();
    setText('headerTenantName', payload.tenant_name || '菜谱商户');
    bindEvents();
    switchSection(sectionFromHash());
  });
})();
