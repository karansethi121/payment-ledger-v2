/* ================= Config ================= */
// payment-ledger-v2 Supabase project (karansethi121's personal account), schema
// already applied. Auto-capture (Stripe/PayPal Edge Functions) is not deployed
// yet -- see README.md for that step.
const SUPABASE_URL = 'https://zanmfrhhmruwebhakdwn.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inphbm1mcmhobXJ1d2ViaGFrZHduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNzI3MDQsImV4cCI6MjEwMDc0ODcwNH0.mBVRRj2kY6RjoJ5iiREBOwy0eowj9AmwlkGlCEpXQ_w';
const USE_SUPABASE = /^https:\/\//.test(SUPABASE_URL) && !SUPABASE_URL.includes('YOUR_SUPABASE');

/* ================= State ================= */
let accounts = [];
let transactions = [];
let withdrawals = [];
let settlements = [];
let outbox = [];
let editingPaymentId = null;
let editingAccountId = null;
let pendingWithdraw = null;
let pendingSettle = null;
let deleteConfirmId = null;
let activeFeedFilter = 'all';
let feedSearchQuery = '';
let feedDateFrom = '';
let feedDateTo = '';
let webhookHealth = {}; // accountId -> { lastReceivedAt, lastError }

const STALE_DAYS_THRESHOLD = 14;
const WEBHOOK_QUIET_DAYS_THRESHOLD = 4; // tighter than STALE_DAYS_THRESHOLD -- webhook silence is a more specific signal than "no sales lately"

// Live FX reference: "1 unit of CUR = ? USD", fetched from Frankfurter (ECB
// reference rates) and cached in localStorage so the app still has *a* rate
// to work with offline -- just possibly a stale one, which fxRatesUpdatedAt
// makes visible rather than silently hiding. The rollup total converts
// through USD regardless of which currency is chosen as the display "home
// currency".
let fxToUSD = { USD: 1, GBP: 1.27, AUD: 0.66 };
let fxHomeCurrency = 'USD';
let fxRatesUpdatedAt = null;

const LS_ACCOUNTS = 'ledgerv2:accounts';
const LS_TRANSACTIONS = 'ledgerv2:transactions';
const LS_WITHDRAWALS = 'ledgerv2:withdrawals';
const LS_SETTLEMENTS = 'ledgerv2:settlements';
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
const timeAgo = (iso) => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}
function accountById(id) { return accounts.find((a) => a.id === id); }
function providerLabel(p) { return { stripe: 'Stripe', paypal: 'PayPal', square: 'Square', invoice: 'Invoice', other: 'Other' }[p] || p; }
// Providers with a webhook (auto-capture) and *-sync (fee/payout) Edge
// Function -- everywhere this app treats a provider specially (webhook
// health warnings, the sync button, "missed webhook?" flags) keys off this
// one list instead of repeating the same three-way OR at each call site.
const AUTO_CAPTURE_PROVIDERS = ['stripe', 'paypal', 'square'];
// Frankfurter serves ECB reference rates, free, no API key, CORS-enabled --
// good fit for a static frontend with no backend of its own to proxy through.
// Rates update once per ECB business day; there's no need to poll more often
// than "once per app load, plus whenever the user opens something FX-related".
async function fetchLiveFxRates() {
  const targets = Object.keys(fxToUSD).filter((c) => c !== 'USD');
  if (targets.length === 0) return false;
  try {
    const res = await fetch(`https://api.frankfurter.dev/v1/latest?from=USD&to=${targets.join(',')}`);
    if (!res.ok) throw new Error(`FX API responded ${res.status}`);
    const data = await res.json();
    targets.forEach((cur) => {
      const rate = data.rates && data.rates[cur];
      if (rate) fxToUSD[cur] = 1 / rate; // API gives "1 USD = X CUR"; app stores "1 CUR = ? USD"
    });
    fxRatesUpdatedAt = data.date || todayISO();
    saveFxSettings();
    return true;
  } catch (e) {
    console.warn('Live FX rate fetch failed, keeping last-known rates:', e);
    return false;
  }
}

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
    related_transaction_id: t.relatedTransactionId || null,
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
function rowFromSettlement(s) {
  return {
    id: s.id, currency: s.currency, gross: s.gross,
    commission_pct: s.commissionPct, commission_amt: s.commissionAmt, net: s.net,
    withdrawal_count: s.withdrawalCount, created_at: s.createdAt
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
    case 'insertSettlement': {
      const { error } = await supabaseClient.from('settlements').insert(rowFromSettlement(item.payload));
      if (error && error.code !== '23505') throw error;
      return;
    }
    case 'tagSettled': {
      const { ids, settlementId } = item.payload;
      const { error } = await supabaseClient.from('withdrawals').update({ settlement_id: settlementId }).in('id', ids);
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
          defaultCurrency: a.default_currency, archived: a.archived, sortOrder: a.sort_order, createdAt: a.created_at,
          // Written only by the *-sync Edge Functions (real Stripe/PayPal
          // balance), never by the client -- so there's no rowFromAccount
          // counterpart for these.
          balanceAvailable: a.balance_available != null ? Number(a.balance_available) : null,
          balanceCurrency: a.balance_currency, balanceSyncedAt: a.balance_synced_at
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
          currency: t.currency, note: t.note || '', externalRef: t.external_ref,
          relatedTransactionId: t.related_transaction_id, withdrawalId: t.withdrawal_id,
          occurredAt: t.occurred_at, createdAt: t.created_at,
          // Backfilled by stripe-sync from Stripe's own Balance Transactions
          // API -- null until synced at least once. fee/net are in
          // providerCurrency (the account's settlement currency), which is
          // NOT necessarily the same as `currency` above (the original
          // charge currency) -- never format them using `currency`.
          providerFee: t.provider_fee != null ? Number(t.provider_fee) : null,
          providerNet: t.provider_net != null ? Number(t.provider_net) : null,
          providerCurrency: t.provider_currency
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
          transactionCount: w.transaction_count, createdAt: w.created_at,
          settlementId: w.settlement_id
        }));
      } catch (e) {
        console.warn('Cloud read for withdrawals failed, using local cache:', e);
      }
    }
    const val = localStorage.getItem(LS_WITHDRAWALS);
    return val ? JSON.parse(val) : [];
  },

  async getSettlements() {
    if (supabaseClient) {
      try {
        const { data, error } = await supabaseClient.from('settlements').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        return data.map((s) => ({
          id: s.id, currency: s.currency, gross: Number(s.gross),
          commissionPct: Number(s.commission_pct), commissionAmt: Number(s.commission_amt), net: Number(s.net),
          withdrawalCount: s.withdrawal_count, createdAt: s.created_at
        }));
      } catch (e) {
        console.warn('Cloud read for settlements failed, using local cache:', e);
      }
    }
    const val = localStorage.getItem(LS_SETTLEMENTS);
    return val ? JSON.parse(val) : [];
  },

  // Purely observational (never written to from the client), so there's no
  // local cache/outbox path here -- if this fails, the health indicator just
  // doesn't show rather than blocking anything else.
  async getWebhookHealth() {
    if (!supabaseClient) return {};
    try {
      const { data, error } = await supabaseClient
        .from('webhook_events')
        .select('account_id, received_at, error')
        .not('account_id', 'is', null)
        .order('received_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const health = {};
      (data || []).forEach((row) => {
        if (!health[row.account_id]) health[row.account_id] = { lastReceivedAt: row.received_at, lastError: row.error };
      });
      return health;
    } catch (e) {
      console.warn('Webhook health fetch failed:', e);
      return {};
    }
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
  },

  // Mirrors processWithdrawal above -- covered withdrawals get tagged with
  // this settlement's id instead of being destroyed, so each one's own
  // commission_pct/commission_amt/net stays intact and auditable.
  async processSettlement(settlement, coveredWithdrawalIds) {
    settlements.unshift(settlement);
    withdrawals = withdrawals.map((w) => (coveredWithdrawalIds.includes(w.id) ? { ...w, settlementId: settlement.id } : w));
    localStorage.setItem(LS_SETTLEMENTS, JSON.stringify(settlements));
    localStorage.setItem(LS_WITHDRAWALS, JSON.stringify(withdrawals));
    if (supabaseClient) {
      queueOutbox('insertSettlement', settlement);
      if (coveredWithdrawalIds.length > 0) queueOutbox('tagSettled', { ids: coveredWithdrawalIds, settlementId: settlement.id });
      await flushOutbox();
    }
  }
};

/* ================= Balance math (always derived, never stored) ================= */
// Refunds/chargebacks subtract from whatever's *currently* available, not
// specifically from the deposit they correct -- if that deposit was already
// withdrawn, this can legitimately go negative (you owe it back next time).
function computeBalances(accountId) {
  const map = {};
  transactions.filter((t) => t.accountId === accountId).forEach((t) => {
    if (!map[t.currency]) map[t.currency] = { available: 0, lifetime: 0, refunded: 0, count: 0 };
    if (t.type === 'refund') {
      map[t.currency].refunded += t.amount;
      if (!t.withdrawalId) map[t.currency].available -= t.amount;
    } else {
      map[t.currency].lifetime += t.amount;
      if (!t.withdrawalId) { map[t.currency].available += t.amount; map[t.currency].count += 1; }
    }
  });
  return map;
}
function lifetimeWithdrawn(accountId, currency) {
  return withdrawals.filter((w) => w.accountId === accountId && w.currency === currency).reduce((s, w) => s + w.gross, 0);
}

// Withdrawals not yet folded into a settlement -- i.e. money that's landed in
// your bank but hasn't been forwarded to your friend yet. Grouped by
// payoutCurrency (not the original charge currency) since that's the actual
// currency sitting in the bank account, and settlements can only bundle
// withdrawals that share one.
function unsettledWithdrawals(payoutCurrency) {
  return withdrawals.filter((w) => !w.settlementId && (w.payoutCurrency || w.currency) === payoutCurrency);
}
function unsettledTotalsByCurrency() {
  const totals = {}; // payoutCurrency -> { net, count }
  withdrawals.filter((w) => !w.settlementId).forEach((w) => {
    const cur = w.payoutCurrency || w.currency;
    if (!totals[cur]) totals[cur] = { net: 0, count: 0 };
    totals[cur].net += w.payoutNet ?? w.net;
    totals[cur].count += 1;
  });
  return totals;
}

// Flags an account with no payment activity (manual or auto) in a while --
// a general "this looks quiet" signal. Only fires for accounts with prior
// history (a brand new account with zero payments isn't "stale", it's just
// new). webhookHealthTag below is the sharper, webhook-specific version of
// this same idea.
function staleWarningTag(acc) {
  if (acc.archived) return '';
  const accTx = transactions.filter((t) => t.accountId === acc.id);
  if (accTx.length === 0) return '';
  const lastDate = accTx.reduce((max, t) => (t.occurredAt > max ? t.occurredAt : max), accTx[0].occurredAt);
  const days = Math.round((new Date(todayISO() + 'T00:00:00') - new Date(lastDate + 'T00:00:00')) / 86400000);
  if (days > STALE_DAYS_THRESHOLD) {
    return `<span class="is-warn" title="Last payment ${fmtDate(lastDate)}">${days}d quiet</span>`;
  }
  return '';
}

// Catches a broken webhook specifically, as distinct from "just no sales" --
// webhook_events logs every verified delivery regardless of whether it
// produced a transaction, including ones where the handler threw after
// verification (error is set but no transaction resulted). That makes this a
// tighter, more specific signal than staleWarningTag: it can go off even for
// an account that's still getting real payments some other way, and it uses
// a shorter threshold since webhook silence is suspicious sooner than "no
// sales" is.
function webhookHealthTag(acc) {
  if (acc.archived) return '';
  if (!AUTO_CAPTURE_PROVIDERS.includes(acc.provider)) return '';
  const health = webhookHealth[acc.id];
  const accountAgeDays = Math.round((new Date() - new Date(acc.createdAt)) / 86400000);
  if (!health) {
    if (accountAgeDays < 2) return ''; // hasn't had a realistic chance to receive one yet
    return `<span class="is-warn" title="No webhook deliveries recorded for this account">no webhook activity</span>`;
  }
  if (health.lastError) {
    return `<span class="is-warn" title="${escapeHtml(health.lastError)}">webhook error</span>`;
  }
  const days = Math.round((new Date() - new Date(health.lastReceivedAt)) / 86400000);
  if (days > WEBHOOK_QUIET_DAYS_THRESHOLD) {
    return `<span class="is-warn" title="Last webhook received ${fmtDate(health.lastReceivedAt.slice(0, 10))}">${days}d since webhook</span>`;
  }
  return '';
}
function sparklineData(accountId, currency, days = 14) {
  // Deposits only -- a single-hue bar chart can't cleanly represent refunds
  // going the other direction without becoming a diverging chart. Refund
  // impact shows in the balance figure and the "refunded" line instead.
  const buckets = new Array(days).fill(0);
  const today = new Date(todayISO() + 'T00:00:00');
  transactions.filter((t) => t.accountId === accountId && t.currency === currency && t.type !== 'refund').forEach((t) => {
    const d = new Date(t.occurredAt + 'T00:00:00');
    const diffDays = Math.round((today - d) / 86400000);
    if (diffDays >= 0 && diffDays < days) buckets[days - 1 - diffDays] += t.amount;
  });
  return buckets;
}
function renderSparkline(buckets) {
  const max = Math.max(...buckets, 0.01);
  return `<div class="sparkline">${buckets.map((v) => `<div class="bar" style="height:${Math.max(2, (v / max) * 24)}px"></div>`).join('')}</div>`;
}

/* ================= Render: hero totals ================= */
// One dominant figure, not a row of equal chips -- the balance is the content,
// so it gets the typographic weight. Multiple currencies fold into a single
// FX rollup as the hero, with the per-currency breakdown demoted to a quiet
// list underneath (rather than competing with the total for attention).
function renderHero() {
  const totals = {};
  accounts.forEach((acc) => {
    const bal = computeBalances(acc.id);
    Object.entries(bal).forEach(([cur, v]) => { totals[cur] = (totals[cur] || 0) + v.available; });
  });
  const wrap = $('heroTotals');
  const entries = Object.entries(totals);

  if (entries.length === 0) {
    wrap.innerHTML = `<div class="hero">
      <div class="hero__label">Available</div>
      <div class="hero__figure hero__figure--empty">—</div>
    </div>`;
    return;
  }

  if (entries.length === 1) {
    const [cur, val] = entries[0];
    wrap.innerHTML = `<div class="hero">
      <div class="hero__label">Available</div>
      <div class="hero__figure ${val < 0 ? 'is-negative' : ''}">${fmt(val, cur)}</div>
    </div>`;
    return;
  }

  const rollup = computeRollupTotal(totals);
  const rows = entries.map(([cur, val]) => `
    <div class="hero__row"><span>${cur}</span><span class="${val < 0 ? 'is-negative' : ''}">${fmt(val, cur)}</span></div>
  `).join('');
  wrap.innerHTML = `<div class="hero">
    <button class="hero__label hero__label--link" id="fxRollupChip" title="Live FX rates -- click for details">≈ ${fxHomeCurrency} Available &middot; live rates ⚙</button>
    <div class="hero__figure ${rollup < 0 ? 'is-negative' : ''}">${fmt(rollup, fxHomeCurrency)}</div>
    <div class="hero__breakdown">${rows}</div>
  </div>`;
  $('fxRollupChip').addEventListener('click', openFxModal);
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
      if (parsed.updatedAt) fxRatesUpdatedAt = parsed.updatedAt;
    } catch (e) { /* keep defaults */ }
  }
}
function saveFxSettings() {
  localStorage.setItem(LS_FXRATES, JSON.stringify({ rates: fxToUSD, home: fxHomeCurrency, updatedAt: fxRatesUpdatedAt }));
}

function openFxModal() {
  $('fxHomeCurrency').value = fxHomeCurrency;
  renderFxRateRows();
  $('fxModal').classList.add('show');
  refreshFxRates(); // always show the freshest rate the moment this is opened
}
function closeFxModal() { $('fxModal').classList.remove('show'); }
function renderFxRateRows() {
  const container = $('fxRateRows');
  const currencies = Object.keys(fxToUSD).filter((c) => c !== 'USD');
  container.innerHTML = currencies.map((cur) => `
    <div class="fx-rate-row">
      <span class="lbl">1 ${cur} =</span>
      <span class="fx-rate-value">${fxToUSD[cur].toFixed(4)} USD</span>
    </div>
  `).join('');
  const status = $('fxUpdatedAt');
  if (status) status.textContent = fxRatesUpdatedAt ? `Live · as of ${fxRatesUpdatedAt}` : 'Live rates';
}
async function refreshFxRates() {
  const status = $('fxUpdatedAt');
  if (status) status.textContent = 'Refreshing…';
  const ok = await fetchLiveFxRates();
  if ($('fxModal').classList.contains('show')) renderFxRateRows();
  if (!ok && status) status.textContent = fxRatesUpdatedAt ? `Live · as of ${fxRatesUpdatedAt} (refresh failed — offline?)` : "Couldn't load live rates — offline?";
  renderAll(); // the hero rollup total also depends on these rates
}
$('fxRatesBtn').addEventListener('click', openFxModal);
$('fxRefreshBtn').addEventListener('click', refreshFxRates);
$('fxCancel').addEventListener('click', closeFxModal);
$('fxModal').addEventListener('click', (e) => { if (e.target.id === 'fxModal') closeFxModal(); });
$('fxSave').addEventListener('click', () => {
  fxHomeCurrency = $('fxHomeCurrency').value;
  saveFxSettings();
  closeFxModal();
  renderAll();
  showToast('Home currency updated');
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
          const refundedLine = b.refunded > 0 ? ` &middot; refunded ${fmt(b.refunded, cur)}` : '';
          return `<div class="balance">
            <div class="balance__row"><span class="balance__cur">${cur}</span><span class="balance__amt ${b.available < 0 ? 'is-negative' : ''}">${fmt(b.available, cur)}</span></div>
            ${renderSparkline(sparklineData(acc.id, cur))}
            <div class="balance__foot"><span>${b.count} pending &middot; lifetime ${fmt(b.lifetime, cur)}${refundedLine}</span><span>withdrawn ${fmt(withdrawn, cur)}</span></div>
            ${b.available > 0 ? `<button class="btn btn-outline balance__withdraw" data-withdraw-account="${acc.id}" data-withdraw-currency="${cur}">Withdraw ${cur}</button>` : ''}
          </div>`;
        }).join('')
      : `<p style="color:var(--ink-muted);font-size:12.5px;margin:0;padding-top:14px;">No payments yet.</p>`;

    // Provider now gets a colored badge next to the name, not a small muted
    // line underneath -- which processor an account is on is glance-critical
    // (it's how auto-capture is wired), so it earns the one place in this UI
    // where color marks identity rather than money state. Bookkeeping facts
    // (archived, stale) stay muted text in the line below.
    //
    // No payment link isn't a warning -- plenty of accounts are deliberately
    // invoiced by hand instead of via a shareable link. So instead of a "No
    // link" flag, the action slot that would hold the copy-link button just
    // says "Invoice" there instead, same spot, same weight.
    const flags = [];
    if (acc.archived) flags.push('Archived');
    const staleFlag = staleWarningTag(acc);
    if (staleFlag) flags.push(staleFlag);
    const webhookFlag = webhookHealthTag(acc);
    if (webhookFlag) flags.push(webhookFlag);
    const metaFlags = flags.map((f) => ` &middot; ${f}`).join('');

    const linkAction = acc.paymentLink
      ? `<button class="copy-link-btn" data-copy-account="${acc.id}" title="Copy payment link">🔗</button>`
      : `<span class="copy-link-btn copy-link-btn--static" title="No payment link -- invoiced manually">Invoice</span>`;

    // Real balance from Stripe/PayPal's own API, as opposed to `b.available`
    // above (our own sum of unwithdrawn transactions) -- shown side by side
    // so a mismatch between the two is visible rather than silently trusted.
    const syncable = AUTO_CAPTURE_PROVIDERS.includes(acc.provider);
    const syncAction = syncable
      ? `<button class="icon-btn" data-sync-account="${acc.id}" data-sync-provider="${acc.provider}" title="Sync real balance/fees from ${providerLabel(acc.provider)}">⟳</button>`
      : '';
    const balanceSyncLine = syncable && acc.balanceAvailable != null
      ? `<div class="account__sync">${providerLabel(acc.provider)} reports ${fmt(acc.balanceAvailable, acc.balanceCurrency)} available &middot; synced ${timeAgo(acc.balanceSyncedAt)}</div>`
      : '';

    return `<article class="account ${acc.archived ? 'is-archived' : ''}">
      <div class="account__head">
        <div class="account__title">
          <div class="account__name-row">
            <h3>${escapeHtml(acc.name)}</h3>
            <span class="provider-badge provider-badge--${acc.provider}">${providerLabel(acc.provider)}</span>
          </div>
          ${metaFlags ? `<div class="account__meta">${metaFlags.replace(/^ &middot; /, '')}</div>` : ''}
        </div>
        <div class="account__actions">
          ${linkAction}
          ${syncAction}
          <button class="icon-btn" data-edit-account="${acc.id}" title="Edit account">✎</button>
        </div>
      </div>
      ${balanceSyncLine}
      <div class="account__balances">${balanceBlocks}</div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-withdraw-account]').forEach((btn) => {
    btn.addEventListener('click', () => openWithdrawModal(btn.dataset.withdrawAccount, btn.dataset.withdrawCurrency));
  });
  grid.querySelectorAll('[data-edit-account]').forEach((btn) => {
    btn.addEventListener('click', () => openAccountModal(btn.dataset.editAccount));
  });
  grid.querySelectorAll('[data-sync-account]').forEach((btn) => {
    btn.addEventListener('click', () => syncAccount(btn.dataset.syncProvider, btn.dataset.syncAccount, btn));
  });
  grid.querySelectorAll('[data-copy-account]').forEach((btn) => {
    btn.addEventListener('click', () => copyAccountLink(btn));
  });
}

// Calls the stripe-sync/paypal-sync Edge Function, which pulls real
// balance/fee data from the provider's own API (see supabase/functions/) --
// a genuinely different credential than the webhook signing secret the app
// already had, so accounts without one configured get a clear error instead
// of a silent no-op. Realtime subscriptions (see init()) would eventually
// pick up the resulting writes on their own, but re-fetching here means the
// UI updates immediately without depending on Realtime being enabled for
// these tables. Only stripe-sync ever returns skippedPayouts/newWithdrawals
// -- paypal-sync doesn't attempt payout reconciliation at all (see its file
// for why), so those simply stay undefined and are skipped below.
async function syncAccount(provider, accountId, btn) {
  if (!supabaseClient) { showToast('Sync needs Supabase to be connected'); return; }
  const original = btn.textContent;
  btn.textContent = '…';
  btn.disabled = true;
  try {
    const { data, error } = await supabaseClient.functions.invoke(`${provider}-sync`, { body: { accountId } });
    if (error) {
      // On a non-2xx response, supabase-js puts it in `error` (not `data`)
      // and only exposes the actual JSON body -- where our function's real
      // message lives -- via `error.context`, a raw Response object.
      let message = error.message;
      if (error.context && typeof error.context.json === 'function') {
        try {
          const body = await error.context.json();
          if (body?.error) message = body.error;
        } catch { /* body wasn't JSON -- fall back to the generic message */ }
      }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);

    accounts = await storageAdapter.getAccounts();
    transactions = await storageAdapter.getTransactions();
    withdrawals = await storageAdapter.getWithdrawals();
    renderAll();

    const parts = [];
    if (data?.feesBackfilled) parts.push(`${data.feesBackfilled} fee${data.feesBackfilled === 1 ? '' : 's'} backfilled`);
    if (data?.newWithdrawals) parts.push(`${data.newWithdrawals} payout${data.newWithdrawals === 1 ? '' : 's'} reconciled`);
    // Stripe won't let this function auto-match which charges a manually
    // triggered payout covered (only automatic-schedule payouts support that
    // lookup) -- surfaced with the real amount/status Stripe reports so it's
    // actionable, not just a count. The withdraw modal's checklist is still
    // how these get recorded.
    if (data?.skippedPayouts?.length) {
      const detail = data.skippedPayouts.map((p) => `${fmt(p.amount, p.currency)} (${p.status}, ${p.arrivalDate})`).join('; ');
      parts.push(`needs manual withdrawal: ${detail}`);
    }
    showToast(parts.length ? `Synced — ${parts.join(', ')}` : 'Synced — no changes');
  } catch (e) {
    showToast(`${providerLabel(provider)} sync failed: ${e.message || e}`);
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
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
  row.innerHTML = chips.map((c) => `<button class="tab ${activeFeedFilter === c.id ? 'active' : ''}" data-filter="${c.id}">${escapeHtml(c.label)}</button>`).join('');
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
    const withdrawn = !!t.withdrawalId;
    const isRefund = t.type === 'refund';
    // Auto-captured rows -- deposits and refunds alike -- mirror what
    // Stripe/PayPal actually reported. Editing OR deleting them would let the
    // ledger silently drift from reality, so neither action is offered,
    // withdrawn or not. Manual entries keep both, same as always.
    const autoCaptured = t.source !== 'manual';
    const editable = !withdrawn && !autoCaptured;
    const deletable = !withdrawn && !autoCaptured;
    const confirming = deleteConfirmId === t.id;
    // Source/kind read as plain words in the meta line, not colored badges --
    // the amount's own color (pine/rust) and sign already say "refund"; a
    // second badge repeating that was just noise competing for attention.
    const metaBits = [fmtDate(t.occurredAt), t.source === 'manual' ? 'Manual' : 'Auto-captured'];
    if (isRefund) metaBits.push('Refund');
    // A manual entry on an account that's wired for auto-capture is worth a
    // second look -- normally that account's payments should arrive via
    // webhook, so this could mean one was missed (or it's a deliberate
    // exception, e.g. a phone order) rather than the expected path.
    if (t.source === 'manual' && !isRefund && acc && AUTO_CAPTURE_PROVIDERS.includes(acc.provider)) {
      metaBits.push(`<span class="is-warn" title="${escapeHtml(acc.name)} is wired for auto-capture -- double check this wasn't also captured by a webhook">missed webhook?</span>`);
    }
    if (t.note) metaBits.push(escapeHtml(t.note));
    const amountTitle = withdrawn ? '' : (autoCaptured ? 'title="Confirmed by Stripe/PayPal/Square -- not editable"' : '');
    const displayAmount = isRefund ? -t.amount : t.amount;
    return `<div class="feed-row">
      <div class="feed-row__left">
        <span class="feed-row__who">${escapeHtml(acc ? acc.name : 'Unknown')}</span>
        <span class="feed-row__meta">${metaBits.join(' · ')}</span>
      </div>
      <div class="feed-row__right">
        <span class="feed-amount ${isRefund ? 'refund' : 'deposit'} ${withdrawn ? 'locked' : ''}" ${amountTitle}>${fmt(displayAmount, t.currency)}</span>
        ${editable ? `<button class="icon-btn edit-btn" data-id="${t.id}" title="Edit">&#9998;</button>` : ''}
        ${deletable ? `<button class="icon-btn delete-btn ${confirming ? 'confirming' : ''}" data-id="${t.id}" title="Delete">${confirming ? 'Confirm' : '&#10005;'}</button>` : ''}
      </div>
    </div>`;
  }
  if (item.kind === 'settlement') {
    const s = item.data;
    return `<div class="feed-row">
      <div class="feed-row__left">
        <span class="feed-row__who">Settlement &middot; sent to friend</span>
        <span class="feed-row__meta">${fmtDate(s.createdAt.slice(0, 10))} &middot; ${s.withdrawalCount} withdrawal${s.withdrawalCount === 1 ? '' : 's'} bundled &middot; ${s.commissionPct}% commission</span>
      </div>
      <div class="feed-row__right"><span class="feed-amount withdrawal">${fmt(s.net, s.currency)}</span></div>
    </div>`;
  }
  const w = item.data;
  const acc = accountById(w.accountId);
  const converted = w.payoutCurrency && w.payoutCurrency !== w.currency;
  const metaConversion = converted ? ` &middot; converted from ${fmt(w.net, w.currency)}` : '';
  const displayAmount = converted ? w.payoutNet : w.net;
  const displayCurrency = converted ? w.payoutCurrency : w.currency;
  const settledTag = w.settlementId ? ' &middot; settled' : '';
  return `<div class="feed-row">
    <div class="feed-row__left">
      <span class="feed-row__who">${escapeHtml(acc ? acc.name : 'Unknown')} &middot; Withdrawal</span>
      <span class="feed-row__meta">${fmtDate(w.createdAt.slice(0, 10))} &middot; ${w.transactionCount} payment${w.transactionCount === 1 ? '' : 's'} &middot; ${w.commissionPct}% commission${metaConversion}${settledTag}</span>
    </div>
    <div class="feed-row__right"><span class="feed-amount withdrawal">${fmt(displayAmount, displayCurrency)}</span></div>
  </div>`;
}

// Shared by both the on-screen feed and CSV export -- "what you see is what
// you export" instead of the export silently ignoring whatever you've
// filtered down to.
function feedFiltersActive() {
  return activeFeedFilter !== 'all' || !!feedDateFrom || !!feedDateTo || !!feedSearchQuery.trim();
}
function getFilteredFeedItems() {
  let items = [];
  transactions.forEach((t) => items.push({ kind: 'deposit', date: t.occurredAt, ts: t.createdAt, data: t }));
  withdrawals.forEach((w) => items.push({ kind: 'withdrawal', date: w.createdAt.slice(0, 10), ts: w.createdAt, data: w }));
  settlements.forEach((s) => items.push({ kind: 'settlement', date: s.createdAt.slice(0, 10), ts: s.createdAt, data: s }));

  // Settlements aren't tied to one account -- an account filter should only
  // ever hide them, never crash comparing accountId to undefined.
  if (activeFeedFilter !== 'all') items = items.filter((i) => i.kind !== 'settlement' && i.data.accountId === activeFeedFilter);
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
  return items;
}

function renderFeed() {
  const container = $('feedContent');
  const items = getFilteredFeedItems();
  const filtersActive = feedFiltersActive();
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
      const t = transactions.find((x) => x.id === id);
      if (t && t.source !== 'manual') { showToast('Auto-captured entries can\'t be deleted'); return; }
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

/* ================= Render: reports ================= */
// This month vs last month (net of refunds, across all accounts) plus
// lifetime commission paid -- the two figures already fully derivable from
// data the app has anyway, just never rolled up anywhere.
function renderReports() {
  const panel = $('reportsPanel');
  if (!panel) return;

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;

  const monthTotals = {}; // currency -> { thisMonth, lastMonth }
  transactions.forEach((t) => {
    const monthKey = t.occurredAt.slice(0, 7);
    if (monthKey !== thisMonthKey && monthKey !== lastMonthKey) return;
    if (!monthTotals[t.currency]) monthTotals[t.currency] = { thisMonth: 0, lastMonth: 0 };
    const signedAmount = t.type === 'refund' ? -t.amount : t.amount;
    monthTotals[t.currency][monthKey === thisMonthKey ? 'thisMonth' : 'lastMonth'] += signedAmount;
  });

  // Commission is now taken in two places: at withdrawal time (w.commissionAmt,
  // in the original charge currency) and again, optionally, at settlement time
  // (s.commissionAmt, in the payout currency being bundled) -- combined here
  // into one lifetime-commission-per-currency total since both are real money
  // kept as commission, just taken at different steps of the same payout.
  const commissionTotals = {}; // currency -> lifetime commission paid
  withdrawals.forEach((w) => { commissionTotals[w.currency] = (commissionTotals[w.currency] || 0) + w.commissionAmt; });
  settlements.forEach((s) => { commissionTotals[s.currency] = (commissionTotals[s.currency] || 0) + s.commissionAmt; });

  const monthCurrencies = Object.keys(monthTotals);
  const commissionCurrencies = Object.keys(commissionTotals);
  const unsettledTotals = unsettledTotalsByCurrency();
  const unsettledCurrencies = Object.keys(unsettledTotals);

  if (monthCurrencies.length === 0 && commissionCurrencies.length === 0 && unsettledCurrencies.length === 0) {
    panel.innerHTML = `<p style="color:var(--ink-muted);font-size:12.5px;margin:0;">No activity yet to report on.</p>`;
    return;
  }

  const monthRows = monthCurrencies.map((cur) => {
    const { thisMonth, lastMonth } = monthTotals[cur];
    let delta = '';
    if (lastMonth !== 0) {
      const pct = ((thisMonth - lastMonth) / Math.abs(lastMonth)) * 100;
      delta = `<span class="report-row__delta ${pct >= 0 ? 'is-up' : 'is-down'}">${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs last month</span>`;
    } else if (thisMonth > 0) {
      delta = `<span class="report-row__delta is-up">new this month</span>`;
    }
    return `<div class="report-row">
      <span class="report-row__label">This month &middot; ${cur}</span>
      <span class="report-row__value">${fmt(thisMonth, cur)} ${delta}</span>
    </div>`;
  }).join('');

  const commissionRows = commissionCurrencies.map((cur) => `
    <div class="report-row">
      <span class="report-row__label">Commission paid &middot; ${cur}</span>
      <span class="report-row__value">${fmt(commissionTotals[cur], cur)}</span>
    </div>
  `).join('');

  // Money that's landed in the bank (withdrawn from some provider account)
  // but hasn't been bundled into a settlement and sent to your friend yet --
  // the "Settle" button opens the same style of checklist modal as Withdraw,
  // just spanning every account that shares this payout currency.
  const unsettledRows = unsettledCurrencies.map((cur) => `
    <div class="report-row">
      <span class="report-row__label">Awaiting settlement &middot; ${cur} <span style="font-weight:400;color:var(--ink-muted);">(${unsettledTotals[cur].count} withdrawal${unsettledTotals[cur].count === 1 ? '' : 's'})</span></span>
      <span class="report-row__value">${fmt(unsettledTotals[cur].net, cur)} <button class="btn btn-outline" data-settle-currency="${cur}" style="margin-left:8px;padding:2px 10px;font-size:12px;">Settle</button></span>
    </div>
  `).join('');

  panel.innerHTML = monthRows + commissionRows + unsettledRows;
  panel.querySelectorAll('[data-settle-currency]').forEach((btn) => {
    btn.addEventListener('click', () => openSettleModal(btn.dataset.settleCurrency));
  });
}

function renderAll() {
  renderHero();
  renderAccountGrid();
  renderFeedFilters();
  renderFeed();
  renderReports();
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
$('mobileFab').addEventListener('click', openPaymentModal);
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
  if (t.source !== 'manual') { showToast('Auto-captured amounts are confirmed by Stripe/PayPal and can\'t be edited'); return; }
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
// Stripe/PayPal payouts don't always cover every pending payment in one go --
// balance can be held back by their payout schedule, a rolling reserve, or
// just partial manual payouts. So instead of sweeping every unwithdrawn
// transaction the moment you click "withdraw" (the old behaviour), the modal
// now lists each pending transaction individually and only tags the ones you
// actually check as withdrawn -- the rest stay available for next time.
function openWithdrawModal(accountId, currency) {
  const acc = accountById(accountId);
  const pending = transactions
    .filter((t) => t.accountId === accountId && t.currency === currency && !t.withdrawalId)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt));
  pendingWithdraw = { accountId, currency, pending, selected: new Set(pending.map((t) => t.id)), gross: 0 };

  $('withdrawTitle').textContent = `Withdraw — ${acc.name}`;
  $('withdrawSub').textContent = `${providerLabel(acc.provider)} · ${currency}`;
  $('withdrawReceivedCurrencyLabel').textContent = ` (${currency})`;
  $('withdrawReceivedAmount').value = '';
  $('commissionPct').value = 10;
  // Both Stripe and PayPal payouts land in GBP in your UK bank regardless of
  // what currency the charges were recorded in -- default the payout
  // currency to match what actually shows up, rather than making you flip it
  // every time.
  $('withdrawPayoutCurrency').value = 'GBP';
  renderWithdrawChecklist();
  recalcWithdrawGross();
  $('withdrawModal').classList.add('show');
  // Refresh in the background so a conversion (if any) is priced off today's
  // rate by the time this is actually confirmed, not whatever was cached.
  fetchLiveFxRates().then((ok) => { if (ok && pendingWithdraw) { renderWithdrawChecklist(); updateWithdrawCalc(); } });
}
function closeWithdrawModal() { $('withdrawModal').classList.remove('show'); pendingWithdraw = null; }

function renderWithdrawChecklist() {
  const list = $('withdrawChecklist');
  const { pending, selected, currency } = pendingWithdraw;
  const payoutCurrency = $('withdrawPayoutCurrency').value;
  if (pending.length === 0) {
    list.innerHTML = `<div class="withdraw-row"><span class="withdraw-row__meta">Nothing pending in this currency.</span></div>`;
  } else {
    list.innerHTML = pending.map((t) => {
      const isRefund = t.type === 'refund';
      const displayAmount = isRefund ? -t.amount : t.amount;
      const fx = payoutCurrency !== currency
        ? ` <span class="withdraw-row__fx">≈ ${fmt(convertCurrency(displayAmount, currency, payoutCurrency), payoutCurrency)}</span>`
        : '';
      // provider_net (from stripe-sync) is what actually became available
      // after Stripe's own cut -- worth surfacing right on the row since
      // that's the number that has to reconcile against your Stripe balance,
      // not the full charge amount. It's in providerCurrency (the account's
      // settlement currency), NOT `currency` -- formatting it with `currency`
      // would silently mislabel the amount (e.g. GBP shown as if it were USD).
      const feeLine = !isRefund && t.providerNet != null ? ` · net ${fmt(t.providerNet, t.providerCurrency || currency)} after fees` : '';
      const metaLine = `${fmtDate(t.occurredAt)}${isRefund ? ' · Refund' : ''}${t.source === 'manual' ? ' · Manual' : ' · Auto-captured'}${feeLine}`;
      return `<label class="withdraw-row">
        <input type="checkbox" data-withdraw-row="${t.id}" ${selected.has(t.id) ? 'checked' : ''}>
        <span class="withdraw-row__meta"><span><b>${fmt(displayAmount, currency)}</b>${fx}</span><span>${metaLine}</span></span>
      </label>`;
    }).join('');
  }
  list.querySelectorAll('[data-withdraw-row]').forEach((box) => {
    box.addEventListener('change', () => {
      const id = box.dataset.withdrawRow;
      if (box.checked) pendingWithdraw.selected.add(id); else pendingWithdraw.selected.delete(id);
      recalcWithdrawGross();
    });
  });
}

// Sums the currently-checked rows the same way computeBalances does (refunds
// subtract) so "selected total" always matches what the checklist shows.
function recalcWithdrawGross() {
  const { pending, selected } = pendingWithdraw;
  const gross = pending.reduce((sum, t) => {
    if (!selected.has(t.id)) return sum;
    return t.type === 'refund' ? sum - t.amount : sum + t.amount;
  }, 0);
  pendingWithdraw.gross = gross;
  $('withdrawSelectedCount').textContent = ` (${selected.size}/${pending.length})`;

  // Only meaningful once stripe-sync has backfilled provider_net on at least
  // one selected row -- null (not 0) for an unsynced account means "unknown,"
  // not "no fee," so the row stays hidden rather than showing a misleading 0.
  // provider_net is in providerCurrency (the account's settlement currency,
  // e.g. GBP), NOT `currency` (the original USD charge amount) -- so this
  // total can only include rows that share the same providerCurrency, and
  // unsynced/refund rows are left out of the sum entirely rather than
  // guessed at, to avoid quietly mixing currencies into one number.
  const selectedDeposits = pending.filter((t) => selected.has(t.id) && t.type !== 'refund');
  const syncedDeposits = selectedDeposits.filter((t) => t.providerNet != null);
  const feeRow = $('withdrawFeeNetRow');
  if (syncedDeposits.length > 0) {
    const providerCurrency = syncedDeposits[0].providerCurrency || pendingWithdraw.currency;
    const netTotal = syncedDeposits.reduce((sum, t) => sum + t.providerNet, 0);
    const partial = syncedDeposits.length < selectedDeposits.length ? ` (${syncedDeposits.length}/${selectedDeposits.length} synced)` : '';
    $('withdrawFeeNetValue').textContent = fmt(netTotal, providerCurrency) + partial;
    feeRow.style.display = 'flex';
  } else {
    feeRow.style.display = 'none';
  }

  const typed = parseFloat($('withdrawReceivedAmount').value);
  const note = $('withdrawAutoSelectNote');
  if (!isNaN(typed) && Math.abs(typed - gross) > 0.01) {
    note.textContent = `Checked payments total ${fmt(gross, pendingWithdraw.currency)}, not the ${fmt(typed, pendingWithdraw.currency)} entered — adjust the checklist above to match what actually landed.`;
    note.style.display = 'block';
  } else {
    note.style.display = 'none';
  }
  updateWithdrawCalc();
}

// `pending` is sorted oldest-first. `targetAmount` is what the user typed in
// "Amount actually received" -- the payout total Stripe/PayPal actually sent,
// which won't always equal the sum of every pending transaction. Decide which
// transactions this payout most plausibly covers and return their ids (the
// checklist gets re-checked to match; the user can still hand-adjust after).
//
// This is a real product decision, not a mechanical one -- a few honest
// approaches, roughly in order of how much they trust "oldest-first":
//   - Greedy oldest-first: keep adding the next-oldest pending transaction
//     while doing so doesn't overshoot targetAmount. Matches Stripe's queue
//     behavior reasonably well (captured charges tend to clear roughly in
//     capture order) and is simple/predictable, but can stop short of an
//     exact match if amounts don't line up.
//   - Exact/closest subset match: search combinations for a subset that sums
//     to (or nearest) targetAmount, ignoring order. Can match a specific
//     payout exactly but is more complex and its pick may be less intuitive
//     than "the oldest ones" when several subsets fit equally well.
//   - Leave it manual: return [] always and let the checklist's own
//     checkboxes be the only selection mechanism (no auto-select at all).
// TODO: implement the auto-select strategy you want here.
function selectTransactionsForAmount(pending, targetAmount) {
  return [];
}

$('withdrawReceivedAmount').addEventListener('change', () => {
  if (!pendingWithdraw) return;
  const target = parseFloat($('withdrawReceivedAmount').value);
  if (isNaN(target)) return;
  const ids = selectTransactionsForAmount(pendingWithdraw.pending, target);
  if (ids && ids.length) {
    pendingWithdraw.selected = new Set(ids);
    renderWithdrawChecklist();
  }
  recalcWithdrawGross();
});

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

  // Selected total leads with the payout currency -- that's the number that
  // has to match your bank statement while you're checking boxes -- with the
  // ledger currency alongside it since that's what the individual rows above
  // are keyed to.
  $('withdrawGross').textContent = payoutCurrency !== currency
    ? `${fmt(convertCurrency(gross, currency, payoutCurrency), payoutCurrency)} (${fmt(gross, currency)})`
    : fmt(gross, currency);
  $('withdrawCommissionAmt').textContent = payoutCurrency !== currency
    ? `${fmt(convertCurrency(commissionAmt, currency, payoutCurrency), payoutCurrency)} (${fmt(commissionAmt, currency)})`
    : fmt(commissionAmt, currency);

  const fxNote = $('withdrawFxNote');
  if (payoutCurrency !== currency) {
    const rate = convertCurrency(1, currency, payoutCurrency);
    const payoutNet = net * rate;
    const asOf = fxRatesUpdatedAt ? ` as of ${fxRatesUpdatedAt}` : '';
    fxNote.textContent = `Converting ${fmt(net, currency)} → ${payoutCurrency} at 1 ${currency} = ${rate.toFixed(4)} ${payoutCurrency} (live rate${asOf}).`;
    fxNote.style.display = 'block';
    $('withdrawNet').textContent = fmt(payoutNet, payoutCurrency);
  } else {
    fxNote.style.display = 'none';
    $('withdrawNet').textContent = fmt(net, currency);
  }
}

$('commissionPct').addEventListener('input', updateWithdrawCalc);
$('withdrawPayoutCurrency').addEventListener('change', () => {
  if (!pendingWithdraw) return;
  renderWithdrawChecklist(); // per-row FX equivalents are keyed to this currency
  updateWithdrawCalc();
});
$('withdrawCancel').addEventListener('click', closeWithdrawModal);
$('withdrawModal').addEventListener('click', (e) => { if (e.target.id === 'withdrawModal') closeWithdrawModal(); });
$('withdrawConfirm').addEventListener('click', async () => {
  if (!pendingWithdraw) return;
  const { accountId, currency, gross, pending, selected } = pendingWithdraw;
  if (selected.size === 0) { showToast('Check at least one payment to withdraw'); return; }
  const acc = accountById(accountId);
  const pct = parseFloat($('commissionPct').value) || 0;
  const commissionAmt = gross * (pct / 100);
  const net = gross - commissionAmt;
  const payoutCurrency = $('withdrawPayoutCurrency').value;
  const fxRateUsed = convertCurrency(1, currency, payoutCurrency);
  const payoutNet = net * fxRateUsed;

  // Only the checked rows get tagged with this withdrawal -- deposits AND
  // refunds alike, so neither is double-counted in future balances. Anything
  // left unchecked stays pending for the next payout. transactionCount only
  // counts deposits though, since that's what reads naturally as "N payments"
  // in the withdrawal history.
  const covered = pending.filter((t) => selected.has(t.id));
  const coveredIds = covered.map((t) => t.id);
  const coveredDepositCount = covered.filter((t) => t.type !== 'refund').length;

  const withdrawal = {
    id: uid(), accountId, currency, gross, commissionPct: pct, commissionAmt, net,
    payoutCurrency, payoutNet, fxRateUsed,
    transactionCount: coveredDepositCount, createdAt: new Date().toISOString()
  };

  await storageAdapter.processWithdrawal(withdrawal, coveredIds);
  closeWithdrawModal();
  renderAll();
  // processWithdrawal's cloud writes go through the outbox, which swallows
  // failures and retries silently (see flushOutbox) -- fine for something
  // that's safe to retry unattended, but a failed "mark these transactions
  // withdrawn" write means they'll look pending again next reload, and get
  // withdrawn a second time. Surface that loudly instead of claiming success.
  if (outbox.length > 0) {
    showToast(`Saved locally but ${outbox.length} change${outbox.length === 1 ? '' : 's'} failed to sync — hit "Retry now" in the banner before withdrawing again, or these payments may look pending again.`);
  } else {
    showToast(`Withdrew ${fmt(payoutNet, payoutCurrency)} from ${acc.name}`);
  }
});

/* ================= Modal: settle ================= */
// Opened from the Reports panel's "Settle" button for a given payout
// currency (not tied to one account -- that's the whole point: it bundles
// unsettled withdrawals across every Stripe/PayPal/Square account that
// happened to pay out in this currency). Mirrors openWithdrawModal/
// renderWithdrawChecklist/recalcWithdrawGross/updateWithdrawCalc below,
// just one level up the chain: withdrawals stand in for transactions, and a
// settlement stands in for a withdrawal.
function openSettleModal(currency) {
  const pending = unsettledWithdrawals(currency)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  pendingSettle = { currency, pending, selected: new Set(pending.map((w) => w.id)), grossUSD: 0, bankAvailable: 0 };

  $('settleTitle').textContent = `Settle — ${currency}`;
  $('settleSub').textContent = `${pending.length} unsettled withdrawal${pending.length === 1 ? '' : 's'}`;
  $('settleCommissionPct').value = 10;
  renderSettleChecklist();
  recalcSettleGross();
  $('settleModal').classList.add('show');
}
function closeSettleModal() { $('settleModal').classList.remove('show'); pendingSettle = null; }

function renderSettleChecklist() {
  const list = $('settleChecklist');
  const { pending, selected, currency } = pendingSettle;
  if (pending.length === 0) {
    list.innerHTML = `<div class="withdraw-row"><span class="withdraw-row__meta">Nothing unsettled in this currency.</span></div>`;
  } else {
    list.innerHTML = pending.map((w) => {
      const acc = accountById(w.accountId);
      // Leads with what the client actually paid (w.gross, pre-any-commission)
      // -- payoutNet is what that already netted down to after the
      // withdrawal's own commission + FX, shown as context alongside it.
      const metaLine = `${fmtDate(w.createdAt.slice(0, 10))} · ${escapeHtml(acc ? acc.name : 'Unknown')} · ${w.transactionCount} payment${w.transactionCount === 1 ? '' : 's'} · already netted to ${fmt(w.payoutNet, currency)} (${w.commissionPct}% taken)`;
      return `<label class="withdraw-row">
        <input type="checkbox" data-settle-row="${w.id}" ${selected.has(w.id) ? 'checked' : ''}>
        <span class="withdraw-row__meta"><span><b>${fmt(w.gross, w.currency)}</b></span><span>${metaLine}</span></span>
      </label>`;
    }).join('');
  }
  list.querySelectorAll('[data-settle-row]').forEach((box) => {
    box.addEventListener('change', () => {
      const id = box.dataset.settleRow;
      if (box.checked) pendingSettle.selected.add(id); else pendingSettle.selected.delete(id);
      recalcSettleGross();
    });
  });
}

// Anchors the settlement to what clients actually paid (w.gross, in each
// withdrawal's own charge currency -- converted to USD as the common unit
// since that's what your clients pay in), not what already landed in the
// bank net of the withdrawal's own commission. bankAvailable tracks that
// already-netted figure separately, purely so updateSettleCalc can warn if
// the commission you set here would work out to owing your friend more than
// is actually sitting in the bank from these withdrawals.
function recalcSettleGross() {
  const { pending, selected } = pendingSettle;
  let grossUSD = 0, bankAvailable = 0;
  pending.forEach((w) => {
    if (!selected.has(w.id)) return;
    grossUSD += convertCurrency(w.gross, w.currency, 'USD');
    bankAvailable += w.payoutNet;
  });
  pendingSettle.grossUSD = grossUSD;
  pendingSettle.bankAvailable = bankAvailable;
  $('settleSelectedCount').textContent = ` (${selected.size}/${pending.length})`;
  updateSettleCalc();
}

// Dollars lead, with the bank/payout currency (what actually moves) in
// brackets -- skips the bracket entirely when they're the same currency.
function fmtUsdFirst(amountUSD, amountBank, bankCurrency) {
  if (bankCurrency === 'USD') return fmt(amountUSD, 'USD');
  return `${fmt(amountUSD, 'USD')} (${fmt(amountBank, bankCurrency)})`;
}

function updateSettleCalc() {
  if (!pendingSettle) return;
  const { grossUSD, bankAvailable, currency } = pendingSettle;
  const pct = parseFloat($('settleCommissionPct').value) || 0;
  const commissionUSD = grossUSD * (pct / 100);
  const netUSD = grossUSD - commissionUSD;
  const grossBank = convertCurrency(grossUSD, 'USD', currency);
  const commissionBank = convertCurrency(commissionUSD, 'USD', currency);
  const netBank = convertCurrency(netUSD, 'USD', currency);

  // Gross (before commission, anchored to what clients paid) leads, exactly
  // like the withdraw modal's "Selected total" -- commission is applied on
  // top of it, not the other way around, so what you owe your friend is
  // always the last figure shown.
  $('settleGross').textContent = fmtUsdFirst(grossUSD, grossBank, currency);
  $('settleCommissionAmt').textContent = fmtUsdFirst(commissionUSD, commissionBank, currency);
  $('settleNet').textContent = fmtUsdFirst(netUSD, netBank, currency);

  // Because this commission is now calculated off the full original client
  // payment rather than what's already netted into the bank, a commission
  // rate too low here can compute a "you owe your friend" figure that
  // exceeds what these withdrawals actually left in the bank -- surface that
  // rather than let it quietly ask you to send money that isn't there.
  const bankNote = $('settleBankNote');
  if (netBank > bankAvailable + 0.01) {
    bankNote.textContent = `⚠️ At ${pct}% commission this works out to ${fmt(netBank, currency)}, but these withdrawals only left ${fmt(bankAvailable, currency)} in the bank after their own commission. Raise the commission % or check fewer withdrawals.`;
    bankNote.style.display = 'block';
  } else {
    bankNote.textContent = `Currently in the bank from these withdrawals: ${fmt(bankAvailable, currency)}.`;
    bankNote.style.display = 'block';
  }
}

$('settleCommissionPct').addEventListener('input', updateSettleCalc);
$('settleCancel').addEventListener('click', closeSettleModal);
$('settleModal').addEventListener('click', (e) => { if (e.target.id === 'settleModal') closeSettleModal(); });
$('settleConfirm').addEventListener('click', async () => {
  if (!pendingSettle) return;
  const { currency, grossUSD, pending, selected } = pendingSettle;
  if (selected.size === 0) { showToast('Check at least one withdrawal to settle'); return; }
  const pct = parseFloat($('settleCommissionPct').value) || 0;
  const commissionUSD = grossUSD * (pct / 100);
  const netUSD = grossUSD - commissionUSD;
  const gross = convertCurrency(grossUSD, 'USD', currency);
  const commissionAmt = convertCurrency(commissionUSD, 'USD', currency);
  const net = convertCurrency(netUSD, 'USD', currency);

  const covered = pending.filter((w) => selected.has(w.id));
  const coveredIds = covered.map((w) => w.id);

  const settlement = {
    id: uid(), currency, gross, commissionPct: pct, commissionAmt, net,
    withdrawalCount: covered.length, createdAt: new Date().toISOString()
  };

  await storageAdapter.processSettlement(settlement, coveredIds);
  closeSettleModal();
  renderAll();
  // Same reasoning as the withdraw confirm above -- a failed tagSettled sync
  // means these withdrawals will look unsettled again on next load, and can
  // get bundled into a second, duplicate settlement.
  if (outbox.length > 0) {
    showToast(`Saved locally but ${outbox.length} change${outbox.length === 1 ? '' : 's'} failed to sync — hit "Retry now" in the banner before settling again, or these withdrawals may look unsettled again.`);
  } else {
    showToast(`Sent ${fmt(net, currency)} to your friend`);
  }
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

// Exports whatever's currently on screen -- respects the account/date/search
// filters on the Activity feed rather than always dumping everything, so
// "what you see is what you export".
$('exportCsvBtn').addEventListener('click', () => {
  const rows = [['Type', 'Date', 'Account', 'Provider', 'Amount', 'Currency', 'Source/Detail', 'Note', 'Status']];
  getFilteredFeedItems().forEach((item) => {
    if (item.kind === 'deposit') {
      const t = item.data;
      const acc = accountById(t.accountId);
      const isRefund = t.type === 'refund';
      const csvAmount = isRefund ? -t.amount : t.amount;
      rows.push([isRefund ? 'Refund' : 'Deposit', t.occurredAt, acc ? acc.name : 'Unknown', acc ? providerLabel(acc.provider) : '', csvAmount.toFixed(2), t.currency, t.source, t.note || '', t.withdrawalId ? 'Withdrawn' : 'Available']);
    } else {
      const w = item.data;
      const acc = accountById(w.accountId);
      const converted = w.payoutCurrency && w.payoutCurrency !== w.currency;
      const detail = `${w.transactionCount} payments, ${w.commissionPct}% commission` + (converted ? `, converted from ${w.net.toFixed(2)} ${w.currency} @ ${w.fxRateUsed}` : '');
      const displayAmount = converted ? w.payoutNet : w.net;
      const displayCurrency = converted ? w.payoutCurrency : w.currency;
      rows.push(['Withdrawal', w.createdAt.slice(0, 10), acc ? acc.name : 'Unknown', acc ? providerLabel(acc.provider) : '', displayAmount.toFixed(2), displayCurrency, detail, '', 'Net']);
    }
  });
  const filtered = feedFiltersActive();
  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  downloadTextFile(`ledger_export${filtered ? '_filtered' : ''}_${todayISO()}.csv`, 'text/csv;charset=utf-8', csv);
  showToast(filtered ? 'Filtered CSV exported' : 'CSV exported');
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
  // Non-blocking -- render with cached/last-known rates first, then swap in
  // live ones whenever they land so a slow or offline fetch never delays
  // first paint.
  fetchLiveFxRates().then((ok) => { if (ok) renderAll(); });
  if (!supabaseClient) seedDemoData();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker registration failed:', e));
    });
  }

  accounts = await storageAdapter.getAccounts();
  transactions = await storageAdapter.getTransactions();
  withdrawals = await storageAdapter.getWithdrawals();
  settlements = await storageAdapter.getSettlements();
  renderAll();

  storageAdapter.getWebhookHealth().then((health) => { webhookHealth = health; renderAccountGrid(); });

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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements' }, async () => {
        settlements = await storageAdapter.getSettlements();
        renderAll();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'accounts' }, async () => {
        accounts = await storageAdapter.getAccounts();
        renderAccountGrid();
        renderAll();
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'webhook_events' }, async () => {
        webhookHealth = await storageAdapter.getWebhookHealth();
        renderAccountGrid();
      })
      .subscribe();
  }
})();
