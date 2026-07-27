/* ================= Config ================= */
// Fill these in once you've created a NEW Supabase project and run supabase/sql/schema.sql.
// Until then, the app runs fully in local "Demo mode" (localStorage only, seeded with sample data)
// so you can try the whole flow before wiring anything up.
const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';
const USE_SUPABASE = /^https:\/\//.test(SUPABASE_URL) && !SUPABASE_URL.includes('YOUR_SUPABASE');

/* ================= State ================= */
let accounts = [];
let transactions = [];
let withdrawals = [];
let outbox = [];
let editingPaymentId = null;
let editingAccountId = null;
let pendingWithdraw = null;
let deleteConfirmId = null;
let activeFeedFilter = 'all';
let feedSearchQuery = '';
let feedDateFrom = '';
let feedDateTo = '';

const STALE_DAYS_THRESHOLD = 14;

// Manual FX reference: "1 unit of CUR = ? USD". Not live -- edited by hand in the
// FX Rates modal. The rollup total converts through USD regardless of which
// currency is chosen as the display "home currency".
let fxToUSD = { USD: 1, GBP: 1.27, AUD: 0.66 };
let fxHomeCurrency = 'USD';

const LS_ACCOUNTS = 'ledgerv2:accounts';
const LS_TRANSACTIONS = 'ledgerv2:transactions';
const LS_WITHDRAWALS = 'ledgerv2:withdrawals';
const LS_OUTBOX = 'ledgerv2:outbox';
const LS_SEEDED = 'ledgerv2:seeded';
const LS_FXRATES = 'ledgerv2:fxrates';

/* ================= Helpers ================= */
const $ = (id) => document.getElementById(id);
const uid = () => 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const fmt = (amount, currency) => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(amount);
  } catch (e) {
    return `${currency} ${amount.toFixed(2)}`;
  }
};
const fmtDate = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function accountById(id) { return accounts.find((a) => a.id === id); }
function providerLabel(p) { return { stripe: 'Stripe', paypal: 'PayPal', invoice: 'Invoice', other: 'Other' }[p] || p; }

function showToast(msg) {
  // Built via textContent/DOM nodes, not innerHTML -- msg often embeds
  // user-editable account names, and this app (unlike v1) lets anyone
  // with access rename accounts, so it can't be trusted as safe markup.
  const t = $('toast');
  t.textContent = '';
  const icon = document.createElement('span');
  icon.textContent = '✨';
  t.appendChild(icon);
  t.appendChild(document.createTextNode(' ' + msg));
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

/* ================= Supabase client ================= */
let supabaseClient = null;
if (USE_SUPABASE && window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

/* ================= Outbox: retry queue for failed cloud writes =================
   Same lesson as v1: apply locally first, queue the cloud write, and if it fails,
   keep it visibly queued (with a retry button) instead of silently dropping it. */
function loadOutbox() { outbox = JSON.parse(localStorage.getItem(LS_OUTBOX) || '[]'); }
function saveOutbox() { localStorage.setItem(LS_OUTBOX, JSON.stringify(outbox)); }
function queueOutbox(type, payload) {
  outbox.push({ id: uid(), type, payload });
  saveOutbox();
  updateSyncBanner();
}
function updateSyncBanner() {
  const banner = $('syncBanner');
  const text = $('syncBannerText');
  if (!banner || !text) return;
  if (!supabaseClient || outbox.length === 0) {
    banner.classList.remove('show');
    return;
  }
  text.textContent = `⚠️ ${outbox.length} change${outbox.length === 1 ? '' : 's'} not synced to cloud`;
  banner.classList.add('show');
}

function rowFromTransaction(t) {
  return {
    id: t.id, account_id: t.accountId, type: t.type || 'deposit', source: t.source,
    amount: t.amount, currency: t.currency, note: t.note, external_ref: t.externalRef || null,
    withdrawal_id: t.withdrawalId || null, occurred_at: t.occurredAt, created_at: t.createdAt
  };
}
function rowFromWithdrawal(w) {
  return {
    id: w.id, account_id: w.accountId, currency: w.currency, gross: w.gross,
    commission_pct: w.commissionPct, commission_amt: w.commissionAmt, net: w.net,
    payout_currency: w.payoutCurrency || w.currency, payout_net: w.payoutNet ?? w.net, fx_rate_used: w.fxRateUsed ?? 1,
    transaction_count: w.transactionCount, created_at: w.createdAt
  };
}
function rowFromAccount(a) {
  return {
    id: a.id, name: a.name, provider: a.provider, payment_link: a.paymentLink || null,
    stripe_payment_link_id: a.stripePaymentLinkId || null, paypal_payee_email: a.paypalPayeeEmail || null,
    default_currency: a.defaultCurrency || 'USD', archived: !!a.archived, sort_order: a.sortOrder || 0,
    created_at: a.createdAt
  };
}

// Note: uses insert()/update() rather than upsert() -- upsert's ON CONFLICT DO
// UPDATE path is known to trip RLS policies that a plain UPDATE sails through
// on this kind of "open anon" Supabase setup (see the v1 ledger's fix notes).
// 23505 (unique_violation) on insert means an earlier attempt already landed,
// so it's treated as success rather than a permanent failure.
async function executeOutboxItem(item) {
  if (!supabaseClient) throw new Error('offline');
  switch (item.type) {
    case 'insertAccount': {
      const { error } = await supabaseClient.from('accounts').insert(rowFromAccount(item.payload));
      if (error && error.code !== '23505') throw error;
      return;
    }
    case 'updateAccount': {
      const { id, patch } = item.payload;
      const row = {};
      if ('name' in patch) row.name = patch.name;
      if ('provider' in patch) row.provider = patch.provider;
      if ('paymentLink' in patch) row.payment_link = patch.paymentLink || null;
      if ('stripePaymentLinkId' in patch) row.stripe_payment_link_id = patch.stripePaymentLinkId || null;
      if ('paypalPayeeEmail' in patch) row.paypal_payee_email = patch.paypalPayeeEmail || null;
      if ('archived' in patch) row.archived = patch.archived;
      const { error } = await supabaseClient.from('accounts').update(row).eq('id', id);
      if (error) throw error;
      return;
    }
    case 'insertTransaction': {
      const { error } = await supabaseClient.from('transactions').insert(rowFromTransaction(item.payload));
      if (error && error.code !== '23505') throw error;
      return;
    }
    case 'updateTransaction': {
      const { id, patch } = item.payload;
      const row = {};
      if ('amount' in patch) row.amount = patch.amount;
      if ('currency' in patch) row.currency = patch.currency;
      if ('occurredAt' in patch) row.occurred_at = patch.occurredAt;
      if ('note' in patch) row.note = patch.note;
      const { error } = await supabaseClient.from('transactions').update(row).eq('id', id);
      if (error) throw error;
      return;
    }
    case 'deleteTransaction': {
      const { error } = await supabaseClient.from('transactions').delete().eq('id', item.payload.id);
      if (error) throw error;
      return;
    }
    case 'insertWithdrawal': {
      const { error } = await supabaseClient.from('withdrawals').insert(rowFromWithdrawal(item.payload));
      if (error && error.code !== '23505') throw error;
      return;
    }
    case 'tagWithdrawn': {
      const { ids, withdrawalId } = item.payload;
      const { error } = await supabaseClient.from('transactions').update({ withdrawal_id: withdrawalId }).in('id', ids);
      if (error) throw error;
      return;
    }
  }
}

async function flushOutbox() {
  if (!supabaseClient || outbox.length === 0) return;
  const remaining = [];
  for (const item of outbox) {
    try {
      await executeOutboxItem(item);
    } catch (e) {
      remaining.push(item);
    }
  }
  outbox = remaining;
  saveOutbox();
  updateSyncBanner();
}

/* ================= Storage adapter ================= */
const storageAdapter = {
  async getAccounts() {
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient.from('accounts').select('*').order('sort_order', { ascending: true });
        if (error) throw error;
        return data.map((a) => ({
          id: a.id, name: a.name, provider: a.provider, paymentLink: a.payment_link,
          stripePaymentLinkId: a.stripe_payment_link_id, paypalPayeeEmail: a.paypal_payee_email,
          defaultCurrency: a.default_currency, archived: a.archived, sortOrder: a.sort_order, createdAt: a.created_at
        }));
      } catch (e) {
        console.warn('Cloud read for accounts failed, using local cache:', e);
      }
    }
    const val = localStorage.getItem(LS_ACCOUNTS);
    return val ? JSON.parse(val) : [];
  },

  async getTransactions() {
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient.from('transactions').select('*');
        if (error) throw error;
        return data.map((t) => ({
          id: t.id, accountId: t.account_id, type: t.type, source: t.source, amount: Number(t.amount),
          currency: t.currency, note: t.note || '', externalRef: t.external_ref, withdrawalId: t.withdrawal_id,
          occurredAt: t.occurred_at, createdAt: t.created_at
        }));
      } catch (e) {
        console.warn('Cloud read for transactions failed, using local cache:', e);
      }
    }
    const val = localStorage.getItem(LS_TRANSACTIONS);
    return val ? JSON.parse(val) : [];
  },

  async getWithdrawals() {
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient.from('withdrawals').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        return data.map((w) => ({
          id: w.id, accountId: w.account_id, currency: w.currency, gross: Number(w.gross),
          commissionPct: Number(w.commission_pct), commissionAmt: Number(w.commission_amt), net: Number(w.net),
          payoutCurrency: w.payout_currency || w.currency, payoutNet: w.payout_net != null ? Number(w.payout_net) : Number(w.net),
          fxRateUsed: w.fx_rate_used != null ? Number(w.fx_rate_used) : 1,
          transactionCount: w.transaction_count, createdAt: w.created_at
        }));
      } catch (e) {
        console.warn('Cloud read for withdrawals failed, using local cache:', e);
      }
    }
    const val = localStorage.getItem(LS_WITHDRAWALS);
    return val ? JSON.parse(val) : [];
  },

  async addAccount(acc) {
    accounts.push(acc);
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts));
    if (supabaseClient) { queueOutbox('insertAccount', acc); await flushOutbox(); }
  },
  async updateAccount(id, patch) {
    accounts = accounts.map((a) => (a.id === id ? { ...a, ...patch } : a));
    localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts));
    if (supabaseClient) { queueOutbox('updateAccount', { id, patch }); await flushOutbox(); }
  },

  async addTransaction(t) {
    transactions.push(t);
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(transactions));
    if (supabaseClient) { queueOutbox('insertTransaction', t); await flushOutbox(); }
  },
  async updateTransaction(id, patch) {
    transactions = transactions.map((t) => (t.id === id ? { ...t, ...patch } : t));
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(transactions));
    if (supabaseClient) { queueOutbox('updateTransaction', { id, patch }); await flushOutbox(); }
  },
  async deleteTransaction(id) {
    transactions = transactions.filter((t) => t.id !== id);
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(transactions));
    if (supabaseClient) { queueOutbox('deleteTransaction', { id }); await flushOutbox(); }
  },

  async processWithdrawal(withdrawal, coveredIds) {
    withdrawals.unshift(withdrawal);
    transactions = transactions.map((t) => (coveredIds.includes(t.id) ? { ...t, withdrawalId: withdrawal.id } : t));
    localStorage.setItem(LS_WITHDRAWALS, JSON.stringify(withdrawals));
    localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(transactions));
    if (supabaseClient) {
      queueOutbox('insertWithdrawal', withdrawal);
      if (coveredIds.length > 0) queueOutbox('tagWithdrawn', { ids: coveredIds, withdrawalId: withdrawal.id });
      await flushOutbox();
    }
  }
};

/* ================= Balance math (always derived, never stored) ================= */
function computeBalances(accountId) {
  const map = {};
  transactions.filter((t) => t.accountId === accountId).forEach((t) => {
    if (!map[t.currency]) map[t.currency] = { available: 0, lifetime: 0, count: 0 };
    map[t.currency].lifetime += t.amount;
    if (!t.withdrawalId) { map[t.currency].available += t.amount; map[t.currency].count += 1; }
  });
  return map;
}
function lifetimeWithdrawn(accountId, currency) {
  return withdrawals.filter((w) => w.accountId === accountId && w.currency === currency).reduce((s, w) => s + w.gross, 0);
}

// Flags an account that's gone quiet -- catches a broken webhook before you
// notice by accident. Only fires for accounts with prior history (a brand new
// account with zero payments isn't "stale", it's just new).
function staleWarningTag(acc) {
  if (acc.archived) return '';
  const accTx = transactions.filter((t) => t.accountId === acc.id);
  if (accTx.length === 0) return '';
  const lastDate = accTx.reduce((max, t) => (t.occurredAt > max ? t.occurredAt : max), accTx[0].occurredAt);
  const days = Math.round((new Date(todayISO() + 'T00:00:00') - new Date(lastDate + 'T00:00:00')) / 86400000);
  if (days > STALE_DAYS_THRESHOLD) {
    return `<span class="tag warning" title="Last payment ${fmtDate(lastDate)}">⚠ ${days}d quiet</span>`;
  }
  return '';
}
function sparklineData(accountId, currency, days = 14) {
  const buckets = new Array(days).fill(0);
  const today = new Date(todayISO() + 'T00:00:00');
  transactions.filter((t) => t.accountId === accountId && t.currency === currency).forEach((t) => {
    const d = new Date(t.occurredAt + 'T00:00:00');
    const diffDays = Math.round((today - d) / 86400000);
    if (diffDays >= 0 && diffDays < days) buckets[days - 1 - diffDays] += t.amount;
  });
  return buckets;
}
function renderSparkline(buckets) {
  const max = Math.max(...buckets, 0.01);
  return `<div class="sparkline">${buckets.map((v) => `<div class="bar" style="height:${Math.max(2, (v / max) * 28)}px"></div>`).join('')}</div>`;
}

/* ================= Render: hero totals ================= */
function renderHero() {
  const totals = {};
  accounts.forEach((acc) => {
    const bal = computeBalances(acc.id);
    Object.entries(bal).forEach(([cur, v]) => { totals[cur] = (totals[cur] || 0) + v.available; });
  });
  const strip = $('heroTotals');
  const entries = Object.entries(totals);
  if (entries.length === 0) {
    strip.innerHTML = `<div class="hero-chip"><div class="lbl">Available</div><div class="val" style="color:var(--text-dim)">—</div></div>`;
    return;
  }
  let html = entries.map(([cur, val]) => `
    <div class="hero-chip"><div class="lbl">${cur} Available</div><div class="val">${fmt(val, cur)}</div></div>
  `).join('');

  if (entries.length > 1) {
    const rollup = computeRollupTotal(totals);
    html += `<div class="hero-chip" style="cursor:pointer;" id="fxRollupChip" title="Manual FX rates -- click to edit">
      <div class="lbl">≈ ${fxHomeCurrency} Total &middot; ⚙</div>
      <div class="val">${fmt(rollup, fxHomeCurrency)}</div>
    </div>`;
  }
  strip.innerHTML = html;
  const chip = $('fxRollupChip');
  if (chip) chip.addEventListener('click', openFxModal);
}

function computeRollupTotal(totalsByCurrency) {
  const homeRate = fxToUSD[fxHomeCurrency] ?? 1;
  return Object.entries(totalsByCurrency).reduce((sum, [cur, val]) => {
    const curRate = fxToUSD[cur] ?? 1;
    return sum + (val * curRate) / homeRate;
  }, 0);
}

function loadFxSettings() {
  const val = localStorage.getItem(LS_FXRATES);
  if (val) {
    try {
      const parsed = JSON.parse(val);
      if (parsed.rates) fxToUSD = { ...fxToUSD, ...parsed.rates };
      if (parsed.home) fxHomeCurrency = parsed.home;
    } catch (e) { /* keep defaults */ }
  }
}
function saveFxSettings() {
  localStorage.setItem(LS_FXRATES, JSON.stringify({ rates: fxToUSD, home: fxHomeCurrency }));
}

function openFxModal() {
  $('fxHomeCurrency').value = fxHomeCurrency;
  renderFxRateRows();
  $('fxModal').classList.add('show');
}
function closeFxModal() { $('fxModal').classList.remove('show'); }
function renderFxRateRows() {
  const container = $('fxRateRows');
  const currencies = Object.keys(fxToUSD).filter((c) => c !== 'USD');
  container.innerHTML = currencies.map((cur) => `
    <div class="fx-rate-row">
      <span class="lbl">1 ${cur} =</span>
      <input type="number" step="0.0001" min="0" data-fx-currency="${cur}" value="${fxToUSD[cur]}"> USD
    </div>
  `).join('');
}
$('fxRatesBtn').addEventListener('click', openFxModal);
$('fxCancel').addEventListener('click', closeFxModal);
$('fxModal').addEventListener('click', (e) => { if (e.target.id === 'fxModal') closeFxModal(); });
$('fxSave').addEventListener('click', () => {
  document.querySelectorAll('[data-fx-currency]').forEach((input) => {
    const cur = input.dataset.fxCurrency;
    const val = parseFloat(input.value);
    if (val > 0) fxToUSD[cur] = val;
  });
  fxHomeCurrency = $('fxHomeCurrency').value;
  saveFxSettings();
  closeFxModal();
  renderAll();
  showToast('FX rates updated');
});

/* ================= Render: account grid ================= */
function renderAccountGrid() {
  const grid = $('accountGrid');
  if (accounts.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
      <div class="glyph">🗂️</div><div class="title">No accounts yet</div>
      <div class="sub">Add an account to start tracking payments.</div>
    </div>`;
    return;
  }

  grid.innerHTML = accounts.map((acc) => {
    const bal = computeBalances(acc.id);
    const currencies = Object.keys(bal);
    const balanceBlocks = currencies.length
      ? currencies.map((cur) => {
          const b = bal[cur];
          const withdrawn = lifetimeWithdrawn(acc.id, cur);
          return `<div>
            <div class="balance-row"><span class="cur">${cur}</span><span class="amt">${fmt(b.available, cur)}</span></div>
            ${renderSparkline(sparklineData(acc.id, cur))}
            <div class="balance-row"><span class="sub">${b.count} pending &middot; lifetime ${fmt(b.lifetime, cur)}</span><span class="sub">withdrawn ${fmt(withdrawn, cur)}</span></div>
            ${b.available > 0 ? `<button class="btn btn-ghost" style="width:100%;margin-top:2px;" data-withdraw-account="${acc.id}" data-withdraw-currency="${cur}" data-withdraw-gross="${b.available}">Withdraw ${cur}</button>` : ''}
          </div>`;
        }).join('<div style="height:1px;background:var(--border-color);margin:2px 0;"></div>')
      : `<p class="sub" style="color:var(--text-dim);font-size:12.5px;margin:0;">No payments yet.</p>`;

    const noLinkInvoiceTag = (!acc.paymentLink && acc.provider === 'invoice') ? '<span class="tag invoice">📄 Invoice</span>' : '';
    const staleTag = staleWarningTag(acc);

    return `<div class="account-card ${acc.archived ? 'archived' : ''}">
      <div class="head">
        <span class="name">${escapeHtml(acc.name)} <span class="tag ${acc.provider}">${providerLabel(acc.provider)}</span>${acc.archived ? '<span class="tag other">Archived</span>' : ''}${noLinkInvoiceTag}${staleTag}</span>
        <div class="head-actions">
          ${acc.paymentLink ? `<button class="copy-link-btn" data-copy-account="${acc.id}" title="Copy payment link">🔗 Copy</button>` : ''}
          <button class="icon-btn" data-edit-account="${acc.id}" title="Edit">✎</button>
        </div>
      </div>
      <div class="balances">${balanceBlocks}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('[data-withdraw-account]').forEach((btn) => {
    btn.addEventListener('click', () => openWithdrawModal(btn.dataset.withdrawAccount, btn.dataset.withdrawCurrency, parseFloat(btn.dataset.withdrawGross)));
  });
  grid.querySelectorAll('[data-edit-account]').forEach((btn) => {
    btn.addEventListener('click', () => openAccountModal(btn.dataset.editAccount));
  });
  grid.querySelectorAll('[data-copy-account]').forEach((btn) => {
    btn.addEventListener('click', () => copyAccountLink(btn));
  });
}

function copyAccountLink(btn) {
  const acc = accountById(btn.dataset.copyAccount);
  if (!acc || !acc.paymentLink) return;
  const link = acc.paymentLink;
  const original = btn.textContent;
  const markCopied = () => {
    btn.textContent = '✓ Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 2000);
  };
  const fallbackCopy = () => {
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    markCopied();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(markCopied).catch(fallbackCopy);
  } else {
    fallbackCopy();
  }
}

/* ================= Render: activity feed ================= */
function renderFeedFilters() {
  const row = $('feedFilterRow');
  const chips = [{ id: 'all', label: 'All' }, ...accounts.map((a) => ({ id: a.id, label: a.name }))];
  row.innerHTML = chips.map((c) => `<button class="filter-chip ${activeFeedFilter === c.id ? 'active' : ''}" data-filter="${c.id}">${escapeHtml(c.label)}</button>`).join('');
  row.querySelectorAll('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => { activeFeedFilter = btn.dataset.filter; renderFeedFilters(); renderFeed(); });
  });
}

$('feedSearch').addEventListener('input', (e) => { feedSearchQuery = e.target.value; renderFeed(); });
$('feedFrom').addEventListener('change', (e) => { feedDateFrom = e.target.value; updateFeedDateClearVisibility(); renderFeed(); });
$('feedTo').addEventListener('change', (e) => { feedDateTo = e.target.value; updateFeedDateClearVisibility(); renderFeed(); });
$('feedDateClear').addEventListener('click', () => {
  feedDateFrom = ''; feedDateTo = '';
  $('feedFrom').value = ''; $('feedTo').value = '';
  updateFeedDateClearVisibility();
  renderFeed();
});
function updateFeedDateClearVisibility() {
  $('feedDateClear').style.display = (feedDateFrom || feedDateTo) ? 'inline-flex' : 'none';
}

function renderFeedRow(item) {
  if (item.kind === 'deposit') {
    const t = item.data;
    const acc = accountById(t.accountId);
    const locked = !!t.withdrawalId;
    const confirming = deleteConfirmId === t.id;
    const sourceTag = t.source === 'manual' ? '<span class="tag source-manual">&#9998; Manual</span>' : '<span class="tag source-auto">&#9889; Auto</span>';
    return `<div class="feed-row">
      <div class="feed-left">
        <span class="who">${escapeHtml(acc ? acc.name : 'Unknown')} ${sourceTag}</span>
        <span class="meta">${fmtDate(t.occurredAt)}${t.note ? ' &middot; ' + escapeHtml(t.note) : ''}</span>
      </div>
      <div class="feed-right">
        <span class="feed-amount deposit ${locked ? 'locked' : ''}">${fmt(t.amount, t.currency)}</span>
        ${!locked ? `
          <button class="icon-btn edit-btn" data-id="${t.id}" title="Edit">&#9998;</button>
          <button class="icon-btn delete-btn ${confirming ? 'confirming' : ''}" data-id="${t.id}" title="Delete">${confirming ? 'Confirm' : '&#10005;'}</button>
        ` : ''}
      </div>
    </div>`;
  }
  const w = item.data;
  const acc = accountById(w.accountId);
  const converted = w.payoutCurrency && w.payoutCurrency !== w.currency;
  const metaConversion = converted ? ` &middot; converted from ${fmt(w.net, w.currency)}` : '';
  const displayAmount = converted ? w.payoutNet : w.net;
  const displayCurrency = converted ? w.payoutCurrency : w.currency;
  return `<div class="feed-row">
    <div class="feed-left">
      <span class="who">${escapeHtml(acc ? acc.name : 'Unknown')} <span class="tag other">Withdrawal</span></span>
      <span class="meta">${fmtDate(w.createdAt.slice(0, 10))} &middot; ${w.transactionCount} payment${w.transactionCount === 1 ? '' : 's'} &middot; ${w.commissionPct}% commission${metaConversion}</span>
    </div>
    <div class="feed-right"><span class="feed-amount withdrawal">${fmt(displayAmount, displayCurrency)}</span></div>
  </div>`;
}

function renderFeed() {
  const container = $('feedContent');
  let items = [];
  transactions.forEach((t) => items.push({ kind: 'deposit', date: t.occurredAt, ts: t.createdAt, data: t }));
  withdrawals.forEach((w) => items.push({ kind: 'withdrawal', date: w.createdAt.slice(0, 10), ts: w.createdAt, data: w }));

  if (activeFeedFilter !== 'all') items = items.filter((i) => i.data.accountId === activeFeedFilter);
  if (feedDateFrom) items = items.filter((i) => i.date >= feedDateFrom);
  if (feedDateTo) items = items.filter((i) => i.date <= feedDateTo);

  const query = feedSearchQuery.trim().toLowerCase();
  if (query) {
    items = items.filter((i) => {
      const acc = accountById(i.data.accountId);
      const accName = acc ? acc.name.toLowerCase() : '';
      if (i.kind === 'deposit') {
        return (i.data.note || '').toLowerCase().includes(query) || i.data.amount.toString().includes(query) || accName.includes(query);
      }
      return accName.includes(query) || i.data.net.toString().includes(query);
    });
  }

  items.sort((a, b) => b.date.localeCompare(a.date) || new Date(b.ts) - new Date(a.ts));

  const filtersActive = activeFeedFilter !== 'all' || feedDateFrom || feedDateTo || query;
  if (items.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="glyph">🧾</div><div class="title">${filtersActive ? 'No matching activity' : 'No activity yet'}</div>
      <div class="sub">${filtersActive ? 'Try widening your search or date range.' : 'Payments you add or auto-capture will show up here.'}</div>
    </div>`;
    return;
  }

  container.innerHTML = `<div class="feed">${items.map(renderFeedRow).join('')}</div>`;

  container.querySelectorAll('.edit-btn').forEach((btn) => btn.addEventListener('click', () => openEditModal(btn.dataset.id)));
  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (deleteConfirmId === id) {
        deleteConfirmId = null;
        await storageAdapter.deleteTransaction(id);
        renderAll();
        showToast('Payment deleted');
      } else {
        deleteConfirmId = id;
        renderFeed();
        setTimeout(() => { if (deleteConfirmId === id) { deleteConfirmId = null; renderFeed(); } }, 3000);
      }
    });
  });
}

function renderAll() {
  renderHero();
  renderAccountGrid();
  renderFeedFilters();
  renderFeed();
  updateSyncBanner();
}

/* ================= Modal: manual payment ================= */
function openPaymentModal() {
  const active = accounts.filter((a) => !a.archived);
  if (active.length === 0) { showToast('Add an account first'); return; }
  $('payAccount').innerHTML = active.map((a) => `<option value="${a.id}">${escapeHtml(a.name)} &middot; ${providerLabel(a.provider)}</option>`).join('');
  $('payAmount').value = '';
  $('payNote').value = '';
  $('payDate').value = todayISO();
  $('payCurrency').value = active[0].defaultCurrency || 'USD';
  $('paymentModal').classList.add('show');
}
function closePaymentModal() { $('paymentModal').classList.remove('show'); }

$('addPaymentBtn').addEventListener('click', openPaymentModal);
$('paymentCancel').addEventListener('click', closePaymentModal);
$('paymentModal').addEventListener('click', (e) => { if (e.target.id === 'paymentModal') closePaymentModal(); });
$('paymentSave').addEventListener('click', async () => {
  const accountId = $('payAccount').value;
  if (!accountId) { showToast('Add an account first'); return; }
  const amount = parseFloat($('payAmount').value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount'); return; }
  const currency = $('payCurrency').value;
  const occurredAt = $('payDate').value || todayISO();
  const note = $('payNote').value.trim();

  const t = { id: uid(), accountId, type: 'deposit', source: 'manual', amount, currency, note, externalRef: null, withdrawalId: null, occurredAt, createdAt: new Date().toISOString() };
  await storageAdapter.addTransaction(t);
  closePaymentModal();
  renderAll();
  showToast(`Added ${fmt(amount, currency)} to ${accountById(accountId).name}`);
});

/* ================= Modal: edit payment ================= */
function openEditModal(id) {
  const t = transactions.find((x) => x.id === id);
  if (!t) return;
  editingPaymentId = id;
  const acc = accountById(t.accountId);
  $('editSub').textContent = acc ? `${acc.name} · ${providerLabel(acc.provider)}` : '';
  $('editCurrency').value = t.currency;
  $('editAmount').value = t.amount;
  $('editDate').value = t.occurredAt;
  $('editNote').value = t.note || '';
  $('editModal').classList.add('show');
}
function closeEditModal() { $('editModal').classList.remove('show'); editingPaymentId = null; }

$('editCancel').addEventListener('click', closeEditModal);
$('editModal').addEventListener('click', (e) => { if (e.target.id === 'editModal') closeEditModal(); });
$('editSave').addEventListener('click', async () => {
  if (!editingPaymentId) return;
  const amount = parseFloat($('editAmount').value);
  if (!amount || amount <= 0) { showToast('Enter a valid amount'); return; }
  const occurredAt = $('editDate').value || todayISO();
  const currency = $('editCurrency').value;
  const note = $('editNote').value.trim();
  await storageAdapter.updateTransaction(editingPaymentId, { amount, occurredAt, currency, note });
  closeEditModal();
  renderAll();
  showToast('Payment updated');
});

/* ================= Modal: withdraw ================= */
function openWithdrawModal(accountId, currency, gross) {
  const acc = accountById(accountId);
  pendingWithdraw = { accountId, currency, gross };
  $('withdrawTitle').textContent = `Withdraw — ${acc.name}`;
  $('withdrawSub').textContent = `${providerLabel(acc.provider)} · ${currency}`;
  $('commissionPct').value = 10;
  $('withdrawPayoutCurrency').value = currency; // defaults to same currency -- no conversion unless you change this
  updateWithdrawCalc();
  $('withdrawModal').classList.add('show');
}
function closeWithdrawModal() { $('withdrawModal').classList.remove('show'); pendingWithdraw = null; }

// Converts an amount between two of the app's currencies via the shared USD
// reference rates (same ones the FX rollup chip uses), so "withdraw as a
// different currency" and "rollup total" always agree on the same rate.
function convertCurrency(amount, fromCur, toCur) {
  if (fromCur === toCur) return amount;
  const fromRate = fxToUSD[fromCur] ?? 1;
  const toRate = fxToUSD[toCur] ?? 1;
  return (amount * fromRate) / toRate;
}

function updateWithdrawCalc() {
  if (!pendingWithdraw) return;
  const { gross, currency } = pendingWithdraw;
  const payoutCurrency = $('withdrawPayoutCurrency').value;
  const pct = parseFloat($('commissionPct').value) || 0;
  const commissionAmt = gross * (pct / 100);
  const net = gross - commissionAmt;

  $('withdrawGross').textContent = fmt(gross, currency);
  $('withdrawCommissionAmt').textContent = fmt(commissionAmt, currency);

  const fxNote = $('withdrawFxNote');
  if (payoutCurrency !== currency) {
    const rate = convertCurrency(1, currency, payoutCurrency);
    const payoutNet = net * rate;
    fxNote.textContent = `Converting ${fmt(net, currency)} → ${payoutCurrency} at 1 ${currency} = ${rate.toFixed(4)} ${payoutCurrency} (from your FX Rates settings).`;
    fxNote.style.display = 'block';
    $('withdrawNet').textContent = fmt(payoutNet, payoutCurrency);
  } else {
    fxNote.style.display = 'none';
    $('withdrawNet').textContent = fmt(net, currency);
  }
}

$('commissionPct').addEventListener('input', updateWithdrawCalc);
$('withdrawPayoutCurrency').addEventListener('change', updateWithdrawCalc);
$('withdrawCancel').addEventListener('click', closeWithdrawModal);
$('withdrawModal').addEventListener('click', (e) => { if (e.target.id === 'withdrawModal') closeWithdrawModal(); });
$('withdrawConfirm').addEventListener('click', async () => {
  if (!pendingWithdraw) return;
  const { accountId, currency, gross } = pendingWithdraw;
  const acc = accountById(accountId);
  const pct = parseFloat($('commissionPct').value) || 0;
  const commissionAmt = gross * (pct / 100);
  const net = gross - commissionAmt;
  const payoutCurrency = $('withdrawPayoutCurrency').value;
  const fxRateUsed = convertCurrency(1, currency, payoutCurrency);
  const payoutNet = net * fxRateUsed;

  const covered = transactions.filter((t) => t.accountId === accountId && t.currency === currency && !t.withdrawalId);
  const coveredIds = covered.map((t) => t.id);

  const withdrawal = {
    id: uid(), accountId, currency, gross, commissionPct: pct, commissionAmt, net,
    payoutCurrency, payoutNet, fxRateUsed,
    transactionCount: covered.length, createdAt: new Date().toISOString()
  };

  await storageAdapter.processWithdrawal(withdrawal, coveredIds);
  closeWithdrawModal();
  renderAll();
  showToast(`Withdrew ${fmt(payoutNet, payoutCurrency)} from ${acc.name}`);
});

/* ================= Modal: account ================= */
function toggleAccProviderFields() {
  const provider = $('accProvider').value;
  $('accStripeWrap').style.display = provider === 'stripe' ? 'block' : 'none';
  $('accPaypalWrap').style.display = provider === 'paypal' ? 'block' : 'none';
}
$('accProvider').addEventListener('change', toggleAccProviderFields);

function openAccountModal(id) {
  editingAccountId = id;
  const acc = id ? accountById(id) : null;
  $('accountModalTitle').textContent = acc ? 'Edit Account' : 'Add Account';
  $('accName').value = acc ? acc.name : '';
  $('accProvider').value = acc ? acc.provider : 'stripe';
  $('accLink').value = acc && acc.paymentLink ? acc.paymentLink : '';
  $('accStripeLinkId').value = acc && acc.stripePaymentLinkId ? acc.stripePaymentLinkId : '';
  $('accPaypalEmail').value = acc && acc.paypalPayeeEmail ? acc.paypalPayeeEmail : '';
  $('accArchivedRow').style.display = acc ? 'flex' : 'none';
  $('accArchived').checked = acc ? !!acc.archived : false;
  toggleAccProviderFields();
  $('accountModal').classList.add('show');
}
function closeAccountModal() { $('accountModal').classList.remove('show'); editingAccountId = null; }

$('addAccountBtn').addEventListener('click', () => openAccountModal(null));
$('accountCancel').addEventListener('click', closeAccountModal);
$('accountModal').addEventListener('click', (e) => { if (e.target.id === 'accountModal') closeAccountModal(); });
$('accountSave').addEventListener('click', async () => {
  const name = $('accName').value.trim();
  if (!name) { showToast('Enter a name'); return; }
  const provider = $('accProvider').value;
  const paymentLink = $('accLink').value.trim();
  const stripePaymentLinkId = $('accStripeLinkId').value.trim();
  const paypalPayeeEmail = $('accPaypalEmail').value.trim();

  if (editingAccountId) {
    const archived = $('accArchived').checked;
    await storageAdapter.updateAccount(editingAccountId, { name, provider, paymentLink, stripePaymentLinkId, paypalPayeeEmail, archived });
    showToast('Account updated');
  } else {
    const acc = {
      id: uid(), name, provider, paymentLink, stripePaymentLinkId, paypalPayeeEmail,
      defaultCurrency: 'USD', archived: false, sortOrder: accounts.length, createdAt: new Date().toISOString()
    };
    await storageAdapter.addAccount(acc);
    showToast('Account added');
  }
  closeAccountModal();
  renderAll();
});

/* ================= Data: CSV / JSON export & import ================= */
function downloadTextFile(filename, mimeType, content) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function csvEscape(val) {
  const str = val == null ? '' : String(val);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

$('exportCsvBtn').addEventListener('click', () => {
  const rows = [['Type', 'Date', 'Account', 'Provider', 'Amount', 'Currency', 'Source/Detail', 'Note', 'Status']];
  transactions.forEach((t) => {
    const acc = accountById(t.accountId);
    rows.push(['Deposit', t.occurredAt, acc ? acc.name : 'Unknown', acc ? providerLabel(acc.provider) : '', t.amount.toFixed(2), t.currency, t.source, t.note || '', t.withdrawalId ? 'Withdrawn' : 'Available']);
  });
  withdrawals.forEach((w) => {
    const acc = accountById(w.accountId);
    const converted = w.payoutCurrency && w.payoutCurrency !== w.currency;
    const detail = `${w.transactionCount} payments, ${w.commissionPct}% commission` + (converted ? `, converted from ${w.net.toFixed(2)} ${w.currency} @ ${w.fxRateUsed}` : '');
    const displayAmount = converted ? w.payoutNet : w.net;
    const displayCurrency = converted ? w.payoutCurrency : w.currency;
    rows.push(['Withdrawal', w.createdAt.slice(0, 10), acc ? acc.name : 'Unknown', acc ? providerLabel(acc.provider) : '', displayAmount.toFixed(2), displayCurrency, detail, '', 'Net']);
  });
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadTextFile(`ledger_export_${todayISO()}.csv`, 'text/csv;charset=utf-8', csv);
  showToast('CSV exported');
});

$('exportJsonBtn').addEventListener('click', () => {
  const json = JSON.stringify({ accounts, transactions, withdrawals }, null, 2);
  downloadTextFile(`ledger_backup_${todayISO()}.json`, 'application/json;charset=utf-8', json);
  showToast('JSON backup downloaded');
});

$('importJsonBtn').addEventListener('click', () => $('importJsonInput').click());
$('importJsonInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const data = JSON.parse(event.target.result);
      if (Array.isArray(data.accounts)) {
        for (const acc of data.accounts) await storageAdapter.addAccount(acc);
      }
      if (Array.isArray(data.transactions)) {
        for (const t of data.transactions) await storageAdapter.addTransaction(t);
      }
      if (Array.isArray(data.withdrawals)) {
        for (const w of data.withdrawals) await storageAdapter.processWithdrawal(w, []);
      }
      accounts = await storageAdapter.getAccounts();
      transactions = await storageAdapter.getTransactions();
      withdrawals = await storageAdapter.getWithdrawals();
      renderAll();
      showToast('Backup imported');
    } catch (err) {
      showToast('Invalid backup JSON file');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

/* ================= Demo seed data (mock mode only, first run) ================= */
function seedDemoData() {
  if (localStorage.getItem(LS_SEEDED)) return;
  localStorage.setItem(LS_SEEDED, '1');

  const acc1 = { id: uid(), name: 'Karan Sethi', provider: 'stripe', paymentLink: 'https://buy.stripe.com/demo', stripePaymentLinkId: '', paypalPayeeEmail: '', defaultCurrency: 'USD', archived: false, sortOrder: 0, createdAt: new Date().toISOString() };
  const acc2 = { id: uid(), name: 'United Goods UK', provider: 'paypal', paymentLink: 'https://paypal.com/demo', stripePaymentLinkId: '', paypalPayeeEmail: '', defaultCurrency: 'USD', archived: false, sortOrder: 1, createdAt: new Date().toISOString() };
  const acc3 = { id: uid(), name: 'Dilpreet Sethi', provider: 'paypal', paymentLink: 'https://paypal.com/demo2', stripePaymentLinkId: '', paypalPayeeEmail: '', defaultCurrency: 'USD', archived: false, sortOrder: 2, createdAt: new Date().toISOString() };
  accounts = [acc1, acc2, acc3];

  const today = new Date();
  const daysAgo = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const dep = (accountId, amount, days, source, note) => ({
    id: uid(), accountId, type: 'deposit', source, amount, currency: 'USD', note: note || '',
    externalRef: null, withdrawalId: null, occurredAt: daysAgo(days), createdAt: new Date(Date.now() - days * 86400000).toISOString()
  });

  transactions = [
    dep(acc1.id, 225, 0, 'stripe_webhook', ''),
    dep(acc1.id, 300, 2, 'stripe_webhook', ''),
    dep(acc1.id, 90, 2, 'manual', 'phone order'),
    dep(acc1.id, 75, 4, 'stripe_webhook', ''),
    dep(acc1.id, 63, 5, 'manual', ''),
    dep(acc2.id, 420, 1, 'paypal_webhook', ''),
    dep(acc2.id, 180, 6, 'paypal_webhook', ''),
    dep(acc3.id, 150, 3, 'manual', 'invoice #12'),
  ];

  localStorage.setItem(LS_ACCOUNTS, JSON.stringify(accounts));
  localStorage.setItem(LS_TRANSACTIONS, JSON.stringify(transactions));
  localStorage.setItem(LS_WITHDRAWALS, JSON.stringify([]));
}

/* ================= Init ================= */
(async function init() {
  const pill = $('modePill');
  pill.textContent = supabaseClient ? '⚡ Supabase Live' : 'Demo mode (local only)';
  pill.classList.toggle('live', !!supabaseClient);

  loadOutbox();
  loadFxSettings();
  if (!supabaseClient) seedDemoData();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker registration failed:', e));
    });
  }

  accounts = await storageAdapter.getAccounts();
  transactions = await storageAdapter.getTransactions();
  withdrawals = await storageAdapter.getWithdrawals();
  renderAll();

  await flushOutbox();
  renderAll();

  $('syncRetryBtn').addEventListener('click', async () => {
    $('syncBannerText').textContent = 'Retrying...';
    await flushOutbox();
    renderAll();
    if (outbox.length === 0) showToast('All changes synced');
  });

  window.addEventListener('online', async () => { await flushOutbox(); renderAll(); });
  setInterval(() => { if (outbox.length > 0) flushOutbox().then(renderAll); }, 20000);

  if (supabaseClient) {
    supabaseClient.channel('public:ledgerv2_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, async () => {
        transactions = await storageAdapter.getTransactions();
        renderAll();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawals' }, async () => {
        withdrawals = await storageAdapter.getWithdrawals();
        renderAll();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, async () => {
        accounts = await storageAdapter.getAccounts();
        renderAccountGrid();
        renderAll();
      })
      .subscribe();
  }
})();
