/* =========================================================
   HISAAB — Personal Budget Ledger
   script.js — all application logic (vanilla JS)
   Chart.js is loaded via CDN in index.html for the category
   breakdown doughnut chart only; everything else is plain JS.
   ========================================================= */

/* ---------------------------------------------------------
   1. CONSTANTS & DATA DICTIONARIES
   --------------------------------------------------------- */

// Average conversion factors (30.44 days/month, 4.345 weeks/month)
const DAYS_PER_MONTH = 30.44;
const WEEKS_PER_MONTH = 4.345;

const CURRENCY_SYMBOLS = {
  PKR: '₨', USD: '$', EUR: '€', GBP: '£', AED: 'د.إ', SAR: '﷼', INR: '₹'
};

// Expense taxonomy: group -> list of predefined items
const EXPENSE_CATEGORIES = {
  Housing: ['Rent', 'Electricity', 'Gas', 'Water', 'Internet', 'Maintenance'],
  Food: ['Groceries', 'Restaurants', 'Snacks', 'Other Food'],
  Transportation: ['Fuel', 'Public Transport', 'Ride Sharing', 'Vehicle Maintenance'],
  Education: ['School Fees', 'University Fees', 'Tuition', 'Books', 'Courses'],
  Health: ['Medicine', 'Doctor', 'Medical Tests', 'Other Healthcare'],
  Personal: ['Clothing', 'Entertainment', 'Shopping', 'Mobile/Phone', 'Other Personal'],
  Financial: ['Loan Payment', 'Credit Card', 'Insurance', 'Investments', 'Savings'],
  Other: ['Miscellaneous']
};

// 50/30/20 grouping: which expense category groups count as Needs / Wants / Savings-Debt
const RULE_GROUPS = {
  needs: ['Housing', 'Food', 'Transportation', 'Health', 'Education'],
  wants: ['Personal', 'Other'],
  savingsDebt: ['Financial']
};

// Colour sequence for the category chart (ties back to the ledger palette)
const CHART_COLORS = ['#1B4D3E', '#B8862E', '#6E8F7E', '#C99B44', '#3E6A57', '#DCC38A', '#8AA898', '#A63D40'];

const STORAGE_KEY = 'hisaab_budget_v1';

/* ---------------------------------------------------------
   1b. SUBSCRIPTION / PAYMENT CONFIGURATION
   This is a frontend-only demo. No real payment gateway is
   connected — nothing here processes actual money. All account
   details below are placeholders; swap them out once a real
   backend/payment gateway is wired up.
   --------------------------------------------------------- */
const SUBSCRIPTION_PRICE = 500; // PKR per month
const SUBSCRIPTION_DURATION_DAYS = 30;
const SUBSCRIPTION_STORAGE_KEY = 'hisaab_subscription_v1';

// Nav views that require an active subscription
const PREMIUM_VIEWS = ['savings', 'rule', 'calculators', 'data'];

// Central place to edit payment account details — placeholder/demo values only.
const paymentConfig = {
  easypaisa: {
    label: 'Easypaisa',
    details: [
      { label: 'Easypaisa Account', value: '03XX-XXXXXXX' },
      { label: 'Account Name', value: 'Hisaab Payments' }
    ],
    note: 'Send ₨500 to the Easypaisa account above and submit your payment details below.',
    fields: [
      { id: 'paySenderName', label: 'Sender Name' },
      { id: 'payAccountNumber', label: 'Easypaisa Number' },
      { id: 'payTxnId', label: 'Transaction ID / Reference Number' }
    ]
  },
  jazzcash: {
    label: 'JazzCash',
    details: [
      { label: 'JazzCash Number', value: '03XX-XXXXXXX' },
      { label: 'Account Name', value: 'Hisaab Payments' }
    ],
    note: 'Send ₨500 to the JazzCash number above and submit your payment details below.',
    fields: [
      { id: 'paySenderName', label: 'Sender Name' },
      { id: 'payAccountNumber', label: 'JazzCash Number' },
      { id: 'payTxnId', label: 'Transaction ID / Reference Number' }
    ]
  },
  bank: {
    label: 'Bank Transfer',
    details: [
      { label: 'Bank Name', value: 'Your Bank Name' },
      { label: 'Account Title', value: 'Hisaab Payments' },
      { label: 'Account Number', value: 'XXXXXXXX' },
      { label: 'IBAN', value: 'PKXX XXXX XXXX XXXX' }
    ],
    note: 'Transfer ₨500 to the account above and enter your transaction/reference number below.',
    fields: [
      { id: 'paySenderName', label: 'Sender Name' },
      { id: 'payBankName', label: 'Bank Name' },
      { id: 'payTxnId', label: 'Transaction / Reference Number' }
    ]
  }
};

/* ---------------------------------------------------------
   2. STATE
   --------------------------------------------------------- */
let state = {
  incomes: [],
  expenses: [],
  savingsGoal: { goalAmount: 0, currentSavings: 0, targetDate: '' },
  settings: { currency: 'PKR' }
};

// Subscription state — kept separate from budget `state` so the
// paid-tier logic never touches the user's actual budget data.
let subscriptionState = {
  status: 'none',        // 'none' | 'pending' | 'active' | 'expired'
  startDate: null,
  expiryDate: null,
  pendingPayment: null,  // payment awaiting demo verification
  history: []            // all submitted payment requests
};

let selectedPaymentMethod = null;

let categoryChart = null;
let autosaveTimer = null;
let pendingConfirmAction = null;

/* ---------------------------------------------------------
   3. UTILITIES
   --------------------------------------------------------- */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function clampNumber(n) {
  const v = parseFloat(n);
  return Number.isFinite(v) ? v : 0;
}

function formatMoney(amount, decimals) {
  const symbol = CURRENCY_SYMBOLS[state.settings.currency] || '';
  const dec = decimals === undefined ? 0 : decimals;
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: Math.max(dec, 2) });
  return `${sign}${symbol} ${formatted}`;
}

function formatPercent(n) {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

// Convert an amount at a given frequency into its monthly equivalent
function toMonthly(amount, frequency) {
  const a = clampNumber(amount);
  switch (frequency) {
    case 'daily': return a * DAYS_PER_MONTH;
    case 'weekly': return a * WEEKS_PER_MONTH;
    case 'yearly': return a / 12;
    case 'monthly':
    default: return a;
  }
}

// Given a monthly figure, derive the other time-scale equivalents
function fromMonthly(monthlyAmount) {
  return {
    daily: monthlyAmount / DAYS_PER_MONTH,
    weekly: monthlyAmount / WEEKS_PER_MONTH,
    monthly: monthlyAmount,
    yearly: monthlyAmount * 12
  };
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { toast.hidden = true; }, 2600);
}

function showConfirm(title, text, onConfirm) {
  document.getElementById('confirmModalTitle').textContent = title;
  document.getElementById('confirmModalText').textContent = text;
  pendingConfirmAction = onConfirm;
  document.getElementById('confirmModal').hidden = false;
}

/* ---------------------------------------------------------
   4. PERSISTENCE (localStorage)
   --------------------------------------------------------- */
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.error('Could not save to localStorage', e);
  }
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(persist, 350);
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    state = {
      incomes: Array.isArray(parsed.incomes) ? parsed.incomes : [],
      expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
      savingsGoal: parsed.savingsGoal || { goalAmount: 0, currentSavings: 0, targetDate: '' },
      settings: parsed.settings || { currency: 'PKR' }
    };
  } catch (e) {
    console.error('Could not read saved budget', e);
  }
}

/* ---------------------------------------------------------
   4b. SUBSCRIPTION PERSISTENCE & STATUS
   --------------------------------------------------------- */
function loadSubscription() {
  try {
    const raw = localStorage.getItem(SUBSCRIPTION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      subscriptionState = {
        status: parsed.status || 'none',
        startDate: parsed.startDate || null,
        expiryDate: parsed.expiryDate || null,
        pendingPayment: parsed.pendingPayment || null,
        history: Array.isArray(parsed.history) ? parsed.history : []
      };
    }
  } catch (e) {
    console.error('Could not read subscription data', e);
  }
  refreshSubscriptionStatus();
}

function persistSubscription() {
  try {
    localStorage.setItem(SUBSCRIPTION_STORAGE_KEY, JSON.stringify(subscriptionState));
  } catch (e) {
    console.error('Could not save subscription data', e);
  }
}

// Flips an Active subscription to Expired once its expiry date has passed.
// Budget data (incomes/expenses/etc.) is never touched by this.
function refreshSubscriptionStatus() {
  if (subscriptionState.status === 'active' && subscriptionState.expiryDate) {
    const expiry = new Date(subscriptionState.expiryDate);
    if (expiry.getTime() < Date.now()) {
      subscriptionState.status = 'expired';
      persistSubscription();
    }
  }
}

function isPremiumActive() {
  return subscriptionState.status === 'active';
}

function getDaysRemaining() {
  if (!subscriptionState.expiryDate) return null;
  const expiry = new Date(subscriptionState.expiryDate);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
}

// The subscription price is always billed in PKR, independent of
// whichever currency the user has selected for their budget view.
function formatPKR(amount) {
  return `₨${amount.toLocaleString()}`;
}

function formatDateReadable(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' });
}

/* ---------------------------------------------------------
   5. CALCULATION HELPERS
   --------------------------------------------------------- */
function getTotalIncomeMonthly() {
  return state.incomes.reduce((sum, i) => sum + toMonthly(i.amount, i.frequency), 0);
}

function getTotalExpensesMonthly() {
  return state.expenses.reduce((sum, e) => sum + toMonthly(e.amount, e.frequency), 0);
}

function getExpensesByCategory() {
  const map = {};
  state.expenses.forEach(e => {
    const monthly = toMonthly(e.amount, e.frequency);
    map[e.category] = (map[e.category] || 0) + monthly;
  });
  return map;
}

function getExpensesByRuleGroup(byCategory) {
  const totals = { needs: 0, wants: 0, savingsDebt: 0 };
  Object.entries(byCategory).forEach(([category, amount]) => {
    if (RULE_GROUPS.needs.includes(category)) totals.needs += amount;
    else if (RULE_GROUPS.wants.includes(category)) totals.wants += amount;
    else if (RULE_GROUPS.savingsDebt.includes(category)) totals.savingsDebt += amount;
    else totals.wants += amount; // custom categories default to "wants"
  });
  return totals;
}

/* ---------------------------------------------------------
   6. NAVIGATION
   --------------------------------------------------------- */
function initNav() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (btn.dataset.premium === 'true' && !isPremiumActive()) {
        document.getElementById('sidebar').classList.remove('open');
        showPremiumLockModal();
        return;
      }
      switchToView(view);
    });
  });

  document.getElementById('navToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
}

// Activates a view + its nav item. Does NOT check premium access —
// callers (nav clicks, the lock modal, dashboard buttons) decide that.
function switchToView(view) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(`view-${view}`).classList.add('active');
  document.getElementById('sidebar').classList.remove('open');

  if (view === 'subscription') {
    refreshSubscriptionStatus();
    renderSubscriptionPage();
    renderDashboardSubCard();
  }
}

function showPremiumLockModal() {
  document.getElementById('premiumLockModal').hidden = false;
}
function hidePremiumLockModal() {
  document.getElementById('premiumLockModal').hidden = true;
}

function updateNavLockIndicators() {
  const active = isPremiumActive();
  document.querySelectorAll('.nav-item[data-premium="true"]').forEach(btn => {
    btn.classList.toggle('locked', !active);
  });
  const dot = document.getElementById('navSubStatusDot');
  dot.classList.remove('active', 'pending', 'expired');
  if (subscriptionState.status === 'active') dot.classList.add('active');
  else if (subscriptionState.status === 'pending') dot.classList.add('pending');
  else if (subscriptionState.status === 'expired') dot.classList.add('expired');
}

function initPremiumLockModal() {
  document.getElementById('lockCancelBtn').addEventListener('click', hidePremiumLockModal);
  document.getElementById('lockSubscribeBtn').addEventListener('click', () => {
    hidePremiumLockModal();
    switchToView('subscription');
    renderSubscriptionPage();
    revealPaymentPanel();
  });
}

/* ---------------------------------------------------------
   7. INCOME — form population & handlers
   --------------------------------------------------------- */
function initIncomeForm() {
  const categorySelect = document.getElementById('incomeCategory');
  const customWrap = document.getElementById('incomeCustomWrap');

  categorySelect.addEventListener('change', () => {
    customWrap.hidden = categorySelect.value !== '__custom';
  });

  document.getElementById('incomeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('incomeFormError');
    errorEl.hidden = true;

    const editId = document.getElementById('incomeEditId').value;
    const categoryValue = categorySelect.value;
    const customName = document.getElementById('incomeCustomName').value.trim();
    const amount = document.getElementById('incomeAmount').value;
    const frequency = document.getElementById('incomeFrequency').value;

    const name = categoryValue === '__custom' ? customName : categoryValue;

    // Validation
    if (!name) { return showFormError(errorEl, 'Please choose or name an income source.'); }
    if (amount === '' || isNaN(amount)) { return showFormError(errorEl, 'Please enter a valid amount.'); }
    if (clampNumber(amount) < 0) { return showFormError(errorEl, 'Income amount cannot be negative.'); }

    if (editId) {
      const entry = state.incomes.find(i => i.id === editId);
      if (entry) { entry.name = name; entry.amount = clampNumber(amount); entry.frequency = frequency; }
      exitIncomeEditMode();
      showToast('Income updated');
    } else {
      state.incomes.push({ id: uid(), name, amount: clampNumber(amount), frequency });
      showToast('Income added');
    }

    e.target.reset();
    document.getElementById('incomeFrequency').value = 'monthly';
    customWrap.hidden = true;
    scheduleAutosave();
    renderAll();
  });

  document.getElementById('incomeCancelEdit').addEventListener('click', () => {
    exitIncomeEditMode();
    document.getElementById('incomeForm').reset();
    document.getElementById('incomeFrequency').value = 'monthly';
    customWrap.hidden = true;
  });
}

function showFormError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function exitIncomeEditMode() {
  document.getElementById('incomeEditId').value = '';
  document.getElementById('incomeFormTitle').textContent = 'Add an income source';
  document.getElementById('incomeSubmitBtn').textContent = 'Add income';
  document.getElementById('incomeCancelEdit').hidden = true;
}

function editIncome(id) {
  const entry = state.incomes.find(i => i.id === id);
  if (!entry) return;
  const categorySelect = document.getElementById('incomeCategory');
  const predefined = Array.from(categorySelect.options).some(o => o.value === entry.name);

  document.getElementById('incomeEditId').value = id;
  document.getElementById('incomeAmount').value = entry.amount;
  document.getElementById('incomeFrequency').value = entry.frequency;

  if (predefined) {
    categorySelect.value = entry.name;
    document.getElementById('incomeCustomWrap').hidden = true;
  } else {
    categorySelect.value = '__custom';
    document.getElementById('incomeCustomWrap').hidden = false;
    document.getElementById('incomeCustomName').value = entry.name;
  }

  document.getElementById('incomeFormTitle').textContent = 'Edit income source';
  document.getElementById('incomeSubmitBtn').textContent = 'Update income';
  document.getElementById('incomeCancelEdit').hidden = false;
  document.getElementById('view-income').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deleteIncome(id) {
  state.incomes = state.incomes.filter(i => i.id !== id);
  scheduleAutosave();
  renderAll();
  showToast('Income removed');
}

/* ---------------------------------------------------------
   8. EXPENSES — form population & handlers
   --------------------------------------------------------- */
function populateExpenseGroups() {
  const groupSelect = document.getElementById('expenseGroup');
  groupSelect.innerHTML = '';
  Object.keys(EXPENSE_CATEGORIES).forEach(group => {
    const opt = document.createElement('option');
    opt.value = group;
    opt.textContent = group;
    groupSelect.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__customGroup';
  customOpt.textContent = 'Custom category…';
  groupSelect.appendChild(customOpt);
  populateExpenseSubcategories(groupSelect.value);
}

function populateExpenseSubcategories(group) {
  const subSelect = document.getElementById('expenseSubcategory');
  const customWrap = document.getElementById('expenseCustomWrap');
  const customLabel = customWrap.querySelector('label');

  if (group === '__customGroup') {
    subSelect.innerHTML = '';
    subSelect.parentElement.hidden = true;
    customWrap.hidden = false;
    customLabel.textContent = 'Custom category & item name';
    return;
  }

  subSelect.parentElement.hidden = false;
  subSelect.innerHTML = '';
  (EXPENSE_CATEGORIES[group] || []).forEach(item => {
    const opt = document.createElement('option');
    opt.value = item;
    opt.textContent = item;
    subSelect.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__custom';
  customOpt.textContent = 'Custom item…';
  subSelect.appendChild(customOpt);

  customLabel.textContent = 'Custom item name';
  customWrap.hidden = subSelect.value !== '__custom';
}

function initExpenseForm() {
  const groupSelect = document.getElementById('expenseGroup');
  const subSelect = document.getElementById('expenseSubcategory');
  const customWrap = document.getElementById('expenseCustomWrap');

  populateExpenseGroups();

  groupSelect.addEventListener('change', () => populateExpenseSubcategories(groupSelect.value));
  subSelect.addEventListener('change', () => {
    if (groupSelect.value !== '__customGroup') {
      customWrap.hidden = subSelect.value !== '__custom';
    }
  });

  document.getElementById('expenseForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('expenseFormError');
    errorEl.hidden = true;

    const editId = document.getElementById('expenseEditId').value;
    const groupValue = groupSelect.value;
    const subValue = subSelect.value;
    const customName = document.getElementById('expenseCustomName').value.trim();
    const amount = document.getElementById('expenseAmount').value;
    const frequency = document.getElementById('expenseFrequency').value;
    const description = document.getElementById('expenseDescription').value.trim();

    let category, name;
    if (groupValue === '__customGroup') {
      if (!customName) return showFormError(errorEl, 'Please name your custom category.');
      category = customName;
      name = customName;
    } else {
      category = groupValue;
      name = subValue === '__custom' ? customName : subValue;
      if (subValue === '__custom' && !customName) return showFormError(errorEl, 'Please name your custom item.');
    }

    if (amount === '' || isNaN(amount)) return showFormError(errorEl, 'Please enter a valid amount.');
    if (clampNumber(amount) < 0) return showFormError(errorEl, 'Expense amount cannot be negative.');
    if (!name) return showFormError(errorEl, 'Please choose or name an expense item.');

    if (editId) {
      const entry = state.expenses.find(x => x.id === editId);
      if (entry) {
        entry.category = category; entry.name = name;
        entry.amount = clampNumber(amount); entry.frequency = frequency; entry.description = description;
      }
      exitExpenseEditMode();
      showToast('Expense updated');
    } else {
      state.expenses.push({ id: uid(), category, name, amount: clampNumber(amount), frequency, description });
      showToast('Expense added');
    }

    e.target.reset();
    populateExpenseGroups();
    document.getElementById('expenseFrequency').value = 'monthly';
    scheduleAutosave();
    renderAll();
  });

  document.getElementById('expenseCancelEdit').addEventListener('click', () => {
    exitExpenseEditMode();
    document.getElementById('expenseForm').reset();
    populateExpenseGroups();
    document.getElementById('expenseFrequency').value = 'monthly';
  });
}

function exitExpenseEditMode() {
  document.getElementById('expenseEditId').value = '';
  document.getElementById('expenseFormTitle').textContent = 'Add an expense';
  document.getElementById('expenseSubmitBtn').textContent = 'Add expense';
  document.getElementById('expenseCancelEdit').hidden = true;
}

function editExpense(id) {
  const entry = state.expenses.find(x => x.id === id);
  if (!entry) return;
  const groupSelect = document.getElementById('expenseGroup');
  const subSelect = document.getElementById('expenseSubcategory');
  const customWrap = document.getElementById('expenseCustomWrap');
  const isPredefinedGroup = Object.prototype.hasOwnProperty.call(EXPENSE_CATEGORIES, entry.category);

  document.getElementById('expenseEditId').value = id;
  document.getElementById('expenseAmount').value = entry.amount;
  document.getElementById('expenseFrequency').value = entry.frequency;
  document.getElementById('expenseDescription').value = entry.description || '';

  if (isPredefinedGroup) {
    groupSelect.value = entry.category;
    populateExpenseSubcategories(entry.category);
    const isPredefinedItem = EXPENSE_CATEGORIES[entry.category].includes(entry.name);
    if (isPredefinedItem) {
      subSelect.value = entry.name;
      customWrap.hidden = true;
    } else {
      subSelect.value = '__custom';
      customWrap.hidden = false;
      document.getElementById('expenseCustomName').value = entry.name;
    }
  } else {
    groupSelect.value = '__customGroup';
    populateExpenseSubcategories('__customGroup');
    document.getElementById('expenseCustomName').value = entry.name;
  }

  document.getElementById('expenseFormTitle').textContent = 'Edit expense';
  document.getElementById('expenseSubmitBtn').textContent = 'Update expense';
  document.getElementById('expenseCancelEdit').hidden = false;
  document.getElementById('view-expenses').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function deleteExpense(id) {
  state.expenses = state.expenses.filter(x => x.id !== id);
  scheduleAutosave();
  renderAll();
  showToast('Expense removed');
}

/* ---------------------------------------------------------
   9. RENDERING — Income & Expense tables
   --------------------------------------------------------- */
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const EDIT_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20l.9-3.6L15.6 5.7a1.5 1.5 0 0 1 2.1 0l.6.6a1.5 1.5 0 0 1 0 2.1L7.6 19.1 4 20Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';

function renderIncomeTable() {
  const tbody = document.getElementById('incomeList');
  if (state.incomes.length === 0) {
    tbody.innerHTML = '<tr class="row-empty"><td colspan="5">No income sources yet — add one above.</td></tr>';
  } else {
    tbody.innerHTML = state.incomes.map(i => {
      const monthly = toMonthly(i.amount, i.frequency);
      return `<tr>
        <td>${escapeHtml(i.name)}</td>
        <td class="amount">${formatMoney(i.amount, 2)}</td>
        <td>${capitalize(i.frequency)}</td>
        <td class="monthly">${formatMoney(monthly, 0)}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" title="Edit" onclick="editIncome('${i.id}')">${EDIT_ICON}</button>
            <button class="icon-btn danger" title="Delete" onclick="deleteIncome('${i.id}')">${TRASH_ICON}</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }
  document.getElementById('totalIncomeDisplay').textContent = formatMoney(getTotalIncomeMonthly(), 0);
}

function renderExpenseTable() {
  const tbody = document.getElementById('expenseList');
  if (state.expenses.length === 0) {
    tbody.innerHTML = '<tr class="row-empty"><td colspan="6">No expenses yet — add one above.</td></tr>';
  } else {
    tbody.innerHTML = state.expenses.map(x => {
      const monthly = toMonthly(x.amount, x.frequency);
      return `<tr>
        <td>${escapeHtml(x.name)}${x.description ? `<br><span style="color:var(--ink-soft);font-size:12px;">${escapeHtml(x.description)}</span>` : ''}</td>
        <td><span class="cat-badge">${escapeHtml(x.category)}</span></td>
        <td class="amount">${formatMoney(x.amount, 2)}</td>
        <td>${capitalize(x.frequency)}</td>
        <td class="monthly">${formatMoney(monthly, 0)}</td>
        <td>
          <div class="row-actions">
            <button class="icon-btn" title="Edit" onclick="editExpense('${x.id}')">${EDIT_ICON}</button>
            <button class="icon-btn danger" title="Delete" onclick="deleteExpense('${x.id}')">${TRASH_ICON}</button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }
  document.getElementById('totalExpensesDisplay').textContent = formatMoney(getTotalExpensesMonthly(), 0);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }

/* ---------------------------------------------------------
   10. DASHBOARD RENDERING
   --------------------------------------------------------- */
function renderDashboard() {
  const totalIncome = getTotalIncomeMonthly();
  const totalExpenses = getTotalExpensesMonthly();
  const remaining = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? (remaining / totalIncome) * 100 : 0;

  document.getElementById('sumTotalIncome').textContent = formatMoney(totalIncome, 0);
  document.getElementById('sumTotalExpenses').textContent = formatMoney(totalExpenses, 0);

  const remainingEl = document.getElementById('sumRemaining');
  remainingEl.textContent = formatMoney(remaining, 0);
  remainingEl.classList.toggle('negative', remaining < 0);
  document.getElementById('sumRemainingLabel').textContent = remaining < 0 ? 'Budget Deficit' : 'Remaining Budget';

  document.getElementById('sumSavingsRate').textContent = totalIncome > 0 ? formatPercent(savingsRate) : '—';

  // Status
  const statusEl = document.getElementById('budgetStatus');
  statusEl.classList.remove('ok', 'warn', 'bad');
  if (totalIncome === 0 && totalExpenses === 0) {
    statusEl.textContent = 'Add data to begin';
  } else if (remaining < 0) {
    statusEl.textContent = '🔴 Overspending';
    statusEl.classList.add('bad');
  } else if (savingsRate < 10) {
    statusEl.textContent = '🟡 Needs Attention';
    statusEl.classList.add('warn');
  } else {
    statusEl.textContent = '🟢 Healthy Budget';
    statusEl.classList.add('ok');
  }

  // Time breakdown table
  const inc = fromMonthly(totalIncome);
  const exp = fromMonthly(totalExpenses);
  const rem = fromMonthly(remaining);
  ['daily', 'weekly', 'monthly', 'yearly'].forEach(period => {
    document.getElementById(`${period}Income`).textContent = formatMoney(inc[period], period === 'daily' ? 2 : 0);
    document.getElementById(`${period}Expenses`).textContent = formatMoney(exp[period], period === 'daily' ? 2 : 0);
    document.getElementById(`${period}Remaining`).textContent = formatMoney(rem[period], period === 'daily' ? 2 : 0);
  });

  renderInsights(totalIncome, totalExpenses, remaining, savingsRate);
  renderCategoryChart();
}

function renderInsights(totalIncome, totalExpenses, remaining, savingsRate) {
  const list = document.getElementById('insightsList');
  const insights = [];

  if (state.incomes.length === 0 && state.expenses.length === 0) {
    list.innerHTML = '<li class="insight-empty">Add income and expenses to generate insights.</li>';
    return;
  }

  if (totalIncome === 0 && totalExpenses > 0) {
    insights.push({ text: `You have no recorded income but ${formatMoney(totalExpenses, 0)} in monthly expenses.`, tone: 'bad' });
  } else if (remaining < 0) {
    insights.push({ text: `You are spending more than you earn — a monthly deficit of ${formatMoney(Math.abs(remaining), 0)}.`, tone: 'bad' });
  } else if (totalIncome > 0) {
    insights.push({ text: `You have ${formatMoney(remaining, 0)} remaining this month.`, tone: 'ok' });
    insights.push({ text: `You are saving ${formatPercent(savingsRate)} of your income.`, tone: savingsRate < 10 ? 'warn' : 'ok' });
  }

  const byCategory = getExpensesByCategory();
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0 && totalIncome > 0) {
    const [topCat, topAmt] = sorted[0];
    const topShare = (topAmt / totalIncome) * 100;
    insights.push({ text: `Your ${topCat.toLowerCase()} expenses are taking ${formatPercent(topShare)} of your income.`, tone: topShare > 35 ? 'warn' : 'ok' });
    if (sorted.length > 1) {
      insights.push({ text: `${sorted[1][0]} is your second-largest spending category at ${formatMoney(sorted[1][1], 0)}/month.`, tone: 'ok' });
    }
  }

  if (totalIncome > 0 && savingsRate < 10 && remaining >= 0) {
    insights.push({ text: 'You may want to reduce discretionary spending to build a stronger savings buffer.', tone: 'warn' });
  }

  list.innerHTML = insights.map(i => `<li class="${i.tone}">${escapeHtml(i.text)}</li>`).join('');
}

function renderCategoryChart() {
  const byCategory = getExpensesByCategory();
  const labels = Object.keys(byCategory);
  const data = Object.values(byCategory);
  const canvas = document.getElementById('categoryChart');
  const emptyNote = document.getElementById('chartEmptyNote');

  if (labels.length === 0) {
    emptyNote.style.display = 'flex';
    canvas.style.display = 'none';
    if (categoryChart) { categoryChart.destroy(); categoryChart = null; }
    return;
  }
  emptyNote.style.display = 'none';
  canvas.style.display = 'block';

  const colors = labels.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]);

  if (categoryChart) {
    categoryChart.data.labels = labels;
    categoryChart.data.datasets[0].data = data;
    categoryChart.data.datasets[0].backgroundColor = colors;
    categoryChart.update();
  } else {
    categoryChart = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#FFFFFF' }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { position: 'right', labels: { font: { family: 'IBM Plex Sans', size: 12 }, boxWidth: 12, padding: 12 } },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total > 0 ? (ctx.parsed / total) * 100 : 0;
                return ` ${ctx.label}: ${formatMoney(ctx.parsed, 0)} (${pct.toFixed(1)}%)`;
              }
            }
          }
        }
      }
    });
  }
}

/* ---------------------------------------------------------
   11. SAVINGS GOAL
   --------------------------------------------------------- */
function initSavingsForm() {
  document.getElementById('savingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('savingsFormError');
    errorEl.hidden = true;

    const goalAmount = document.getElementById('goalAmount').value;
    const currentSavings = document.getElementById('currentSavings').value;
    const targetDate = document.getElementById('targetDate').value;

    if (goalAmount !== '' && clampNumber(goalAmount) < 0) return showFormError(errorEl, 'Goal amount cannot be negative.');
    if (currentSavings !== '' && clampNumber(currentSavings) < 0) return showFormError(errorEl, 'Current savings cannot be negative.');

    state.savingsGoal = {
      goalAmount: clampNumber(goalAmount),
      currentSavings: clampNumber(currentSavings),
      targetDate: targetDate || ''
    };
    scheduleAutosave();
    renderSavingsGoal();
    showToast('Savings goal saved');
  });
}

function renderSavingsGoal() {
  const { goalAmount, currentSavings, targetDate } = state.savingsGoal;
  document.getElementById('goalAmount').value = goalAmount || '';
  document.getElementById('currentSavings').value = currentSavings || '';
  document.getElementById('targetDate').value = targetDate || '';

  const remaining = Math.max(goalAmount - currentSavings, 0);
  const percent = goalAmount > 0 ? Math.min((currentSavings / goalAmount) * 100, 100) : 0;

  document.getElementById('goalProgressBar').style.width = `${percent}%`;
  document.getElementById('goalProgressBar').classList.toggle('over', currentSavings >= goalAmount && goalAmount > 0);
  document.getElementById('goalPercent').textContent = formatPercent(percent);
  document.getElementById('goalRemaining').textContent = formatMoney(remaining, 0);

  let daysLeft = null;
  if (targetDate) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const target = new Date(targetDate);
    daysLeft = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  }
  document.getElementById('goalDaysLeft').textContent = daysLeft !== null ? (daysLeft > 0 ? daysLeft : 'Past due') : '—';

  if (daysLeft && daysLeft > 0 && remaining > 0) {
    const monthsLeft = daysLeft / DAYS_PER_MONTH;
    const weeksLeft = daysLeft / 7;
    document.getElementById('goalMonthly').textContent = formatMoney(remaining / monthsLeft, 0);
    document.getElementById('goalWeekly').textContent = formatMoney(remaining / weeksLeft, 0);
    document.getElementById('goalDaily').textContent = formatMoney(remaining / daysLeft, 2);
  } else {
    document.getElementById('goalMonthly').textContent = remaining > 0 ? '—' : formatMoney(0, 0);
    document.getElementById('goalWeekly').textContent = remaining > 0 ? '—' : formatMoney(0, 0);
    document.getElementById('goalDaily').textContent = remaining > 0 ? '—' : formatMoney(0, 2);
  }
}

/* ---------------------------------------------------------
   12. 50/30/20 RULE
   --------------------------------------------------------- */
function renderRule() {
  const totalIncome = getTotalIncomeMonthly();
  const byCategory = getExpensesByCategory();
  const groups = getExpensesByRuleGroup(byCategory);

  const recommended = {
    needs: totalIncome * 0.5,
    wants: totalIncome * 0.3,
    savingsDebt: totalIncome * 0.2
  };

  setRuleBlock('needs', groups.needs, recommended.needs, totalIncome);
  setRuleBlock('wants', groups.wants, recommended.wants, totalIncome);
  setRuleBlock('savingsRule', groups.savingsDebt, recommended.savingsDebt, totalIncome);
}

function setRuleBlock(prefix, actual, recommended, totalIncome) {
  const barId = prefix === 'savingsRule' ? 'savingsRuleBar' : `${prefix}Bar`;
  const actualId = `${prefix}Actual`;
  const recId = `${prefix}Recommended`;

  const pctOfIncome = totalIncome > 0 ? (actual / totalIncome) * 100 : 0;
  const targetPct = prefix === 'needs' ? 50 : prefix === 'wants' ? 30 : 20;
  const barWidth = Math.min(pctOfIncome, 100);

  const bar = document.getElementById(barId);
  bar.style.width = `${barWidth}%`;
  bar.classList.toggle('over', pctOfIncome > targetPct);

  document.getElementById(actualId).textContent = `${formatMoney(actual, 0)} (${formatPercent(pctOfIncome)})`;
  document.getElementById(recId).textContent = formatMoney(recommended, 0);
}

/* ---------------------------------------------------------
   13. QUICK CALCULATOR
   --------------------------------------------------------- */
function initQuickCalculator() {
  const display = document.getElementById('quickCalcDisplay');
  let current = '0';
  let previous = null;
  let operator = null;
  let justEvaluated = false;

  function updateDisplay() { display.value = current; }

  function inputDigit(d) {
    if (justEvaluated) { current = '0'; justEvaluated = false; }
    if (d === '.' && current.includes('.')) return;
    current = current === '0' && d !== '.' ? d : current + d;
  }

  function chooseOperator(op) {
    if (operator && !justEvaluated) evaluate();
    previous = parseFloat(current);
    operator = op;
    justEvaluated = false;
    current = '0';
  }

  function evaluate() {
    if (operator === null || previous === null) return;
    const curr = parseFloat(current);
    let result;
    switch (operator) {
      case '+': result = previous + curr; break;
      case '-': result = previous - curr; break;
      case '*': result = previous * curr; break;
      case '/': result = curr === 0 ? NaN : previous / curr; break;
      default: result = curr;
    }
    current = Number.isFinite(result) ? String(Math.round(result * 1e6) / 1e6) : 'Error';
    operator = null;
    previous = null;
    justEvaluated = true;
  }

  document.getElementById('quickCalcGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = btn.dataset.key;

    if (key === 'clear') { current = '0'; previous = null; operator = null; justEvaluated = false; }
    else if (key === '=') { evaluate(); }
    else if (key === '%') { current = String(parseFloat(current || '0') / 100); }
    else if (['+', '-', '*', '/'].includes(key)) { chooseOperator(key); }
    else { inputDigit(key); }

    updateDisplay();
  });
}

/* ---------------------------------------------------------
   14. PERCENT / TAX / LOAN CALCULATORS
   --------------------------------------------------------- */
function initSmallCalculators() {
  document.getElementById('pctForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = clampNumber(document.getElementById('pctAmount').value);
    const percent = clampNumber(document.getElementById('pctPercent').value);
    const result = (amount * percent) / 100;
    document.getElementById('pctResult').innerHTML = `${formatPercent(percent)} of ${formatMoney(amount, 0)} is <strong>${formatMoney(result, 2)}</strong>.`;
  });

  document.getElementById('taxForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const amount = clampNumber(document.getElementById('taxAmount').value);
    const rate = clampNumber(document.getElementById('taxRate').value);
    const type = document.getElementById('taxType').value;
    const delta = (amount * rate) / 100;
    const isAdd = ['tax', 'increase', 'profit'].includes(type);
    const total = isAdd ? amount + delta : amount - delta;
    const label = { tax: 'Tax', discount: 'Discount', increase: 'Increase', decrease: 'Decrease', profit: 'Profit', loss: 'Loss' }[type];
    document.getElementById('taxResult').innerHTML =
      `${label}: <strong>${formatMoney(delta, 2)}</strong> &nbsp;•&nbsp; Total: <strong>${formatMoney(total, 2)}</strong>`;
  });

  document.getElementById('loanForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const principal = clampNumber(document.getElementById('loanAmount').value);
    const annualRate = clampNumber(document.getElementById('loanRate').value);
    const durationRaw = clampNumber(document.getElementById('loanDuration').value);
    const unit = document.getElementById('loanDurationUnit').value;
    const months = unit === 'years' ? durationRaw * 12 : durationRaw;

    if (principal <= 0 || months <= 0) {
      document.getElementById('loanResults').hidden = true;
      showToast('Enter a loan amount and duration greater than zero.');
      return;
    }

    const monthlyRate = annualRate / 12 / 100;
    let emi;
    if (monthlyRate === 0) {
      emi = principal / months;
    } else {
      const factor = Math.pow(1 + monthlyRate, months);
      emi = (principal * monthlyRate * factor) / (factor - 1);
    }
    const totalPayment = emi * months;
    const totalInterest = totalPayment - principal;

    document.getElementById('loanMonthlyPayment').textContent = formatMoney(emi, 2);
    document.getElementById('loanTotalPayment').textContent = formatMoney(totalPayment, 0);
    document.getElementById('loanTotalInterest').textContent = formatMoney(totalInterest, 0);
    document.getElementById('loanResults').hidden = false;
  });
}

/* ---------------------------------------------------------
   15. DATA / SETTINGS / EXPORT
   --------------------------------------------------------- */
function initDataControls() {
  document.getElementById('saveBudgetBtn').addEventListener('click', () => {
    persist();
    document.getElementById('saveStatus').textContent = `Saved at ${new Date().toLocaleTimeString()}.`;
    showToast('Budget saved');
  });

  document.getElementById('resetBudgetBtn').addEventListener('click', () => {
    showConfirm('Reset budget?', 'This reloads your last saved data and discards any unsaved changes on this page.', () => {
      loadFromStorage();
      applySettingsToUI();
      renderAll();
      showToast('Budget reset to last save');
    });
  });

  document.getElementById('clearAllBtn').addEventListener('click', () => {
    showConfirm('Clear all data?', 'This permanently deletes every income source, expense, and goal you have entered. This cannot be undone.', () => {
      state = { incomes: [], expenses: [], savingsGoal: { goalAmount: 0, currentSavings: 0, targetDate: '' }, settings: state.settings };
      persist();
      renderAll();
      renderSavingsGoal();
      showToast('All data cleared');
    });
  });

  document.getElementById('confirmYesBtn').addEventListener('click', () => {
    if (pendingConfirmAction) pendingConfirmAction();
    pendingConfirmAction = null;
    document.getElementById('confirmModal').hidden = true;
  });
  document.getElementById('confirmNoBtn').addEventListener('click', () => {
    pendingConfirmAction = null;
    document.getElementById('confirmModal').hidden = true;
  });

  document.getElementById('printBtn').addEventListener('click', () => {
    buildPrintSummary();
    window.print();
  });

  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);

  document.getElementById('currencySelect').addEventListener('change', (e) => {
    state.settings.currency = e.target.value;
    scheduleAutosave();
    renderAll();
  });
}

function applySettingsToUI() {
  document.getElementById('currencySelect').value = state.settings.currency || 'PKR';
}

function exportCsv() {
  const rows = [['Type', 'Name', 'Category', 'Amount', 'Frequency', 'Monthly Equivalent', 'Description']];
  state.incomes.forEach(i => rows.push(['Income', i.name, '', i.amount, i.frequency, toMonthly(i.amount, i.frequency).toFixed(2), '']));
  state.expenses.forEach(x => rows.push(['Expense', x.name, x.category, x.amount, x.frequency, toMonthly(x.amount, x.frequency).toFixed(2), x.description || '']));

  const totalIncome = getTotalIncomeMonthly();
  const totalExpenses = getTotalExpensesMonthly();
  rows.push([]);
  rows.push(['Summary', '', '', '', '', '', '']);
  rows.push(['Total Income (Monthly)', totalIncome.toFixed(2)]);
  rows.push(['Total Expenses (Monthly)', totalExpenses.toFixed(2)]);
  rows.push(['Remaining Budget (Monthly)', (totalIncome - totalExpenses).toFixed(2)]);

  const csv = rows.map(r => r.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hisaab-budget-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('CSV exported');
}

function buildPrintSummary() {
  const totalIncome = getTotalIncomeMonthly();
  const totalExpenses = getTotalExpensesMonthly();
  const remaining = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? (remaining / totalIncome) * 100 : 0;

  const incomeRows = state.incomes.map(i =>
    `<tr><td>${escapeHtml(i.name)}</td><td>${formatMoney(i.amount, 2)}</td><td>${capitalize(i.frequency)}</td><td>${formatMoney(toMonthly(i.amount, i.frequency), 0)}</td></tr>`
  ).join('') || '<tr><td colspan="4">No income recorded.</td></tr>';

  const expenseRows = state.expenses.map(x =>
    `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.category)}</td><td>${formatMoney(x.amount, 2)}</td><td>${capitalize(x.frequency)}</td><td>${formatMoney(toMonthly(x.amount, x.frequency), 0)}</td></tr>`
  ).join('') || '<tr><td colspan="5">No expenses recorded.</td></tr>';

  document.getElementById('printSummary').innerHTML = `
    <h1>Hisaab — Budget Summary</h1>
    <p>Generated ${new Date().toLocaleString()}</p>
    <h2>Overview (Monthly)</h2>
    <table>
      <tr><th>Total Income</th><td>${formatMoney(totalIncome, 0)}</td></tr>
      <tr><th>Total Expenses</th><td>${formatMoney(totalExpenses, 0)}</td></tr>
      <tr><th>Remaining Budget</th><td>${formatMoney(remaining, 0)}</td></tr>
      <tr><th>Savings Rate</th><td>${totalIncome > 0 ? formatPercent(savingsRate) : '—'}</td></tr>
    </table>
    <h2>Income</h2>
    <table><tr><th>Source</th><th>Amount</th><th>Frequency</th><th>Monthly Equiv.</th></tr>${incomeRows}</table>
    <h2>Expenses</h2>
    <table><tr><th>Item</th><th>Category</th><th>Amount</th><th>Frequency</th><th>Monthly Equiv.</th></tr>${expenseRows}</table>
  `;
}

/* ---------------------------------------------------------
   15b. SUBSCRIPTION PAGE, PAYMENT FLOW & DASHBOARD CARD
   --------------------------------------------------------- */
const CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PREMIUM_BENEFITS = [
  'Complete Budget Calculator', 'Unlimited Income Sources', 'Unlimited Expense Tracking',
  'Savings Goals', '50/30/20 Rule', 'Financial Insights', 'Expense Charts',
  'Loan / EMI Calculator', 'Tax & Percentage Calculator', 'Budget Export',
  'CSV Export', 'Print Budget', 'Data Persistence', 'All future premium features'
];

// Reveals the payment method panel and scrolls it into view.
function revealPaymentPanel() {
  document.getElementById('subPaymentPanel').hidden = false;
  document.getElementById('subPaymentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hidePaymentPanel() {
  document.getElementById('subPaymentPanel').hidden = true;
  document.getElementById('paymentForm').hidden = true;
  document.getElementById('paymentInstructions').innerHTML = '';
  document.querySelectorAll('input[name="paymentMethod"]').forEach(r => { r.checked = false; });
  selectedPaymentMethod = null;
}

/* ---- Dashboard mini subscription card ---- */
function renderDashboardSubCard() {
  const card = document.getElementById('dashboardSubCard');
  const status = subscriptionState.status;

  if (status === 'active') {
    const days = getDaysRemaining();
    card.className = 'sub-status-card';
    card.innerHTML = `
      <div class="sub-status-card-text">
        <h3>Hisaab Premium — Active</h3>
        <p>${formatPKR(SUBSCRIPTION_PRICE)}/month &nbsp;•&nbsp; Expires in ${days !== null ? Math.max(days, 0) : '—'} day${days === 1 ? '' : 's'}</p>
      </div>
      <button class="btn btn-primary" id="dashManageSubBtn">Manage Subscription</button>`;
  } else if (status === 'pending') {
    card.className = 'sub-status-card';
    card.innerHTML = `
      <div class="sub-status-card-text">
        <h3>Payment Verification Pending</h3>
        <p>Your ${formatPKR(SUBSCRIPTION_PRICE)}/month payment is awaiting verification.</p>
      </div>
      <button class="btn btn-primary" id="dashManageSubBtn">View Status</button>`;
  } else if (status === 'expired') {
    card.className = 'sub-status-card expired';
    card.innerHTML = `
      <div class="sub-status-card-text">
        <h3>Subscription Expired</h3>
        <p>Renew to keep using Savings Goal, the 50/30/20 Rule, Calculators and Data &amp; Export.</p>
      </div>
      <button class="btn btn-primary" id="dashManageSubBtn">Renew — ${formatPKR(SUBSCRIPTION_PRICE)}/month</button>`;
  } else {
    card.className = 'sub-status-card inactive';
    card.innerHTML = `
      <div class="sub-status-card-text">
        <h3>Premium Required</h3>
        <p>Unlock the complete Hisaab Budget Calculator.</p>
      </div>
      <button class="btn btn-primary" id="dashManageSubBtn">Subscribe — ${formatPKR(SUBSCRIPTION_PRICE)}/month</button>`;
  }

  document.getElementById('dashManageSubBtn').addEventListener('click', () => {
    switchToView('subscription');
    renderSubscriptionPage();
    if (status !== 'active') revealPaymentPanel();
  });
}

/* ---- Main subscription/upgrade page ---- */
function renderSubscriptionPage() {
  const status = subscriptionState.status;
  const pill = document.getElementById('subStatusPill');
  pill.classList.remove('ok', 'warn', 'bad');

  if (status === 'active') pill.textContent = 'Premium Active ✓';
  else if (status === 'pending') pill.textContent = 'Payment Verification Pending';
  else if (status === 'expired') pill.textContent = 'Subscription Expired';
  else pill.textContent = 'Subscription Required';

  if (status === 'active') pill.classList.add('ok');
  else if (status === 'pending') pill.classList.add('warn');
  else if (status === 'expired') pill.classList.add('bad');

  const hero = document.getElementById('subHeroPanel');
  const benefitsHtml = `<ul class="sub-benefits">${PREMIUM_BENEFITS.map(b => `<li>${CHECK_ICON}${b}</li>`).join('')}</ul>`;

  if (status === 'active') {
    const days = getDaysRemaining();
    let countdownClass = '';
    let countdownText = `Your subscription expires in ${Math.max(days, 0)} day${days === 1 ? '' : 's'}.`;
    if (days !== null && days <= 7 && days > 0) { countdownClass = 'warn'; countdownText += ' Renew to continue using Premium.'; }
    else if (days !== null && days <= 0) { countdownClass = 'bad'; }

    hero.innerHTML = `
      <div class="sub-hero-top">
        <div>
          <span class="premium-badge">PREMIUM ACTIVE</span>
          <h2>Hisaab Premium</h2>
          <p class="panel-sub">Started ${formatDateReadable(subscriptionState.startDate)} &nbsp;•&nbsp; Expires ${formatDateReadable(subscriptionState.expiryDate)}</p>
        </div>
        <div class="sub-price">${formatPKR(SUBSCRIPTION_PRICE)}<span>/month</span></div>
      </div>
      <p class="sub-countdown ${countdownClass}">${countdownText}</p>
      ${benefitsHtml}`;
    document.getElementById('subPaymentPanel').hidden = true;
    document.getElementById('demoVerifyPanel').hidden = true;
  } else if (status === 'pending') {
    const p = subscriptionState.pendingPayment;
    hero.innerHTML = `
      <div class="sub-hero-top">
        <div>
          <span class="premium-badge">PENDING</span>
          <h2>Hisaab Premium</h2>
          <p class="panel-sub">Your payment has been submitted and is awaiting verification.</p>
        </div>
        <div class="sub-price">${formatPKR(SUBSCRIPTION_PRICE)}<span>/month</span></div>
      </div>
      <p class="sub-pending-note">Payment submitted successfully via ${p ? paymentConfig[p.method].label : '—'}. Your subscription is pending verification.</p>
      ${benefitsHtml}`;
    document.getElementById('subPaymentPanel').hidden = true;
    document.getElementById('demoVerifyPanel').hidden = false;
  } else if (status === 'expired') {
    hero.innerHTML = `
      <div class="sub-hero-top">
        <div>
          <span class="premium-badge">EXPIRED</span>
          <h2>Hisaab Premium</h2>
          <p class="panel-sub">Your subscription expired on ${formatDateReadable(subscriptionState.expiryDate)}. Your budget data is safe and untouched.</p>
        </div>
        <div class="sub-price">${formatPKR(SUBSCRIPTION_PRICE)}<span>/month</span></div>
      </div>
      ${benefitsHtml}
      <div class="field-btn"><button class="btn btn-primary" id="heroRenewBtn">Renew for ${formatPKR(SUBSCRIPTION_PRICE)}/month</button></div>`;
    document.getElementById('heroRenewBtn').addEventListener('click', revealPaymentPanel);
    document.getElementById('demoVerifyPanel').hidden = true;
  } else {
    hero.innerHTML = `
      <div class="sub-hero-top">
        <div>
          <h2>Hisaab Premium</h2>
          <p class="panel-sub">Unlock the complete Budget Calculator and all financial tools.</p>
        </div>
        <div class="sub-price">${formatPKR(SUBSCRIPTION_PRICE)}<span>/month</span></div>
      </div>
      ${benefitsHtml}
      <div class="field-btn"><button class="btn btn-primary" id="heroSubscribeBtn">Subscribe for ${formatPKR(SUBSCRIPTION_PRICE)}/month</button></div>`;
    document.getElementById('heroSubscribeBtn').addEventListener('click', revealPaymentPanel);
    document.getElementById('demoVerifyPanel').hidden = true;
  }

  renderPaymentHistory();
  updateNavLockIndicators();
}

/* ---- Payment method selection & dynamic instructions ---- */
function renderPaymentInstructions(method) {
  const cfg = paymentConfig[method];
  const container = document.getElementById('paymentInstructions');
  const detailRows = cfg.details.map(d => `<div class="pay-detail-row"><span>${d.label}:</span><span>${d.value}</span></div>`).join('');

  container.innerHTML = `
    <div class="pay-instructions">
      <h3>Pay with ${cfg.label}</h3>
      <div class="pay-detail-row"><span>Amount:</span><span>${formatPKR(SUBSCRIPTION_PRICE)}</span></div>
      ${detailRows}
      <p class="pay-note">${cfg.note}</p>
    </div>`;

  const fieldsContainer = document.getElementById('paymentFormFields');
  fieldsContainer.innerHTML = cfg.fields.map(f => `
    <div class="field">
      <label for="${f.id}">${f.label}</label>
      <input type="text" id="${f.id}" maxlength="60" required>
    </div>`).join('');

  document.getElementById('paymentForm').hidden = false;
  document.getElementById('paymentFormError').hidden = true;
}

function initPaymentMethodSelection() {
  document.querySelectorAll('input[name="paymentMethod"]').forEach(radio => {
    radio.addEventListener('change', () => {
      selectedPaymentMethod = radio.value;
      renderPaymentInstructions(radio.value);
    });
  });

  document.getElementById('paymentCancelBtn').addEventListener('click', hidePaymentPanel);

  document.getElementById('paymentForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('paymentFormError');
    errorEl.hidden = true;

    if (!selectedPaymentMethod) return showFormError(errorEl, 'Please choose a payment method.');
    const cfg = paymentConfig[selectedPaymentMethod];
    const values = {};
    for (const f of cfg.fields) {
      const val = document.getElementById(f.id).value.trim();
      if (!val) return showFormError(errorEl, `Please fill in "${f.label}".`);
      values[f.id] = val;
    }

    // Build the payment record. Only non-sensitive info is stored —
    // no passwords, PINs, OTPs or card numbers are ever collected.
    const payment = {
      id: uid(),
      method: selectedPaymentMethod,
      amount: SUBSCRIPTION_PRICE,
      senderName: values.paySenderName || '',
      accountRef: values.payAccountNumber || values.payBankName || '',
      txnId: values.payTxnId || '',
      submittedDate: new Date().toISOString(),
      status: 'pending' // Default status — never auto-marked as paid
    };

    subscriptionState.status = 'pending';
    subscriptionState.pendingPayment = payment;
    subscriptionState.history.unshift(payment);
    persistSubscription();

    hidePaymentPanel();
    renderSubscriptionPage();
    renderDashboardSubCard();
    showToast('Payment submitted successfully. Your subscription is pending verification.');
  });
}

/* ---- Demo verification (clearly labelled simulated backend step) ---- */
function initDemoVerification() {
  document.getElementById('demoApproveBtn').addEventListener('click', () => {
    if (!subscriptionState.pendingPayment) return;

    const now = new Date();
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + SUBSCRIPTION_DURATION_DAYS);

    subscriptionState.pendingPayment.status = 'verified';
    // Reflect the verified status in history too
    const histEntry = subscriptionState.history.find(p => p.id === subscriptionState.pendingPayment.id);
    if (histEntry) histEntry.status = 'verified';

    subscriptionState.status = 'active';
    subscriptionState.startDate = now.toISOString();
    subscriptionState.expiryDate = expiry.toISOString();
    subscriptionState.pendingPayment = null;
    persistSubscription();

    renderSubscriptionPage();
    renderDashboardSubCard();
    showToast('Demo verification complete — Premium activated.');
  });
}

function renderPaymentHistory() {
  const panel = document.getElementById('subHistoryPanel');
  const tbody = document.getElementById('paymentHistoryList');
  if (subscriptionState.history.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  tbody.innerHTML = subscriptionState.history.map(p => `
    <tr>
      <td>${new Date(p.submittedDate).toLocaleDateString()}</td>
      <td>${escapeHtml(paymentConfig[p.method] ? paymentConfig[p.method].label : p.method)}</td>
      <td class="amount">${formatPKR(p.amount)}</td>
      <td>${escapeHtml(p.txnId)}</td>
      <td><span class="pay-status-chip ${p.status === 'verified' ? 'verified' : 'pending'}">${p.status === 'verified' ? 'Verified' : 'Pending Verification'}</span></td>
    </tr>`).join('');
}

/* ---------------------------------------------------------
   16. MASTER RENDER
   --------------------------------------------------------- */
function renderAll() {
  renderIncomeTable();
  renderExpenseTable();
  renderDashboard();
  renderRule();
  renderDashboardSubCard();
  updateNavLockIndicators();
}

/* ---------------------------------------------------------
   17. INIT
   --------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  loadFromStorage();
  loadSubscription();
  applySettingsToUI();

  initNav();
  initIncomeForm();
  initExpenseForm();
  initSavingsForm();
  initQuickCalculator();
  initSmallCalculators();
  initDataControls();
  initPremiumLockModal();
  initPaymentMethodSelection();
  initDemoVerification();

  renderAll();
  renderSavingsGoal();
  renderSubscriptionPage();
});
