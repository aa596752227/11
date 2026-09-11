const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const PROVIDERS = {
  doubao: { name: '豆包', url: 'https://www.doubao.com/' },
  dola: { name: 'Dola', url: 'https://www.dola.com/' }
};

function storageFile(dataRoot) { return path.join(dataRoot, '内置浏览器账号.json'); }
function readStore(dataRoot) {
  try {
    const value = JSON.parse(fs.readFileSync(storageFile(dataRoot), 'utf8'));
    return { version: 1, accounts: Array.isArray(value.accounts) ? value.accounts : [] };
  } catch { return { version: 1, accounts: [] }; }
}
function writeStore(dataRoot, value) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const file = storageFile(dataRoot), temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function todayUsage(account) {
  const date = todayKey();
  const count = account?.videoUsageDate === date ? Math.max(0, Number(account.videoUsageCount) || 0) : 0;
  return { todayVideoDate: date, todayVideoCount: count, todayVideoHot: count >= 2 };
}
function publicAccount(account) {
  const { encryptedCredential, ...visible } = account;
  return { ...visible, ...todayUsage(account), hasCredential: Boolean(encryptedCredential), url: PROVIDERS[account.provider]?.url || account.url || '' };
}
function encryptCredential(username, password) {
  if (!username && !password) return '';
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 安全存储当前不可用，未保存账号密码');
  return safeStorage.encryptString(JSON.stringify({ username: String(username || ''), password: String(password || '') })).toString('base64');
}
function decryptCredential(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return { username: '', password: '' };
  try { return JSON.parse(safeStorage.decryptString(Buffer.from(value, 'base64'))); }
  catch { return { username: '', password: '' }; }
}
function normalizeProvider(value) { return String(value || '').toLowerCase() === 'dola' ? 'dola' : 'doubao'; }

function list(dataRoot) { return readStore(dataRoot).accounts.map(publicAccount); }
function upsert(dataRoot, input) {
  const store = readStore(dataRoot);
  const provider = normalizeProvider(input.provider);
  const id = String(input.id || crypto.randomUUID());
  const current = store.accounts.find(account => account.id === id);
  const credential = input.username !== undefined || input.password !== undefined
    ? encryptCredential(input.username, input.password)
    : current?.encryptedCredential || '';
  const account = {
    ...(current || {}), id, provider,
    name: String(input.name || current?.name || `${PROVIDERS[provider].name}账号`).trim(),
    encryptedCredential: credential,
    partition: `persist:jx-${provider}-${id.replace(/[^a-z0-9-]/gi, '').slice(0, 50)}`,
    url: PROVIDERS[provider].url,
    quotaStatus: current?.quotaStatus || 'unknown', quotaValue: current?.quotaValue ?? null,
    videoUsageDate: current?.videoUsageDate || '', videoUsageCount: current?.videoUsageCount || 0,
    enabled: input.enabled !== false, updatedAt: new Date().toISOString()
  };
  const index = store.accounts.findIndex(item => item.id === id);
  if (index >= 0) store.accounts[index] = account; else store.accounts.push(account);
  writeStore(dataRoot, store);
  return publicAccount(account);
}
function parseDolaCredentialLines(text) {
  const rows = [];
  String(text || '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^\s*[`'"]+|[`'"]+\s*$/g, '').replace(/&#x20;|&nbsp;/gi, ' ').trim();
    if (!line || !line.includes('----')) return;
    const parts = line.split('----').map(part => part.trim());
    const username = (parts[0] || '').replace(/\\([@.])/g, '$1').trim();
    const password = (parts[1] || '').trim();
    if (/^(账号|邮箱|email|username|user)$/i.test(username) && /^(密码|password|pass)$/i.test(password)) return;
    if (!username || !password) throw new Error(`第 ${index + 1} 行缺少邮箱或密码`);
    rows.push({ provider: 'dola', name: `Dola · ${username}`, username, password });
  });
  return rows;
}
function importMany(dataRoot, inputs) {
  const results = [];
  for (const input of Array.isArray(inputs) ? inputs.slice(0, 100) : []) results.push(upsert(dataRoot, input));
  return results;
}
function remove(dataRoot, id) {
  const store = readStore(dataRoot);
  store.accounts = store.accounts.filter(account => account.id !== id);
  writeStore(dataRoot, store);
  return { ok: true };
}
function credential(dataRoot, id) {
  const account = readStore(dataRoot).accounts.find(item => item.id === id);
  if (!account) throw new Error('账号不存在');
  return decryptCredential(account.encryptedCredential);
}
function updateQuota(dataRoot, id, status) {
  const store = readStore(dataRoot);
  const account = store.accounts.find(item => item.id === id);
  if (!account) return null;
  if (status && Object.prototype.hasOwnProperty.call(status, 'quotaStatus')) {
    account.quotaStatus = ['available', 'exhausted'].includes(status.quotaStatus) ? status.quotaStatus : 'unknown';
    account.quotaValue = Number.isFinite(Number(status?.quotaValue)) ? Number(status.quotaValue) : null;
    account.quotaText = String(status?.quotaText || '').slice(0, 300);
    account.quotaCheckedAt = new Date().toISOString();
  }
  const pageUserName = String(status?.pageUserName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (pageUserName) account.pageUserName = pageUserName;
  writeStore(dataRoot, store);
  return publicAccount(account);
}
function incrementVideoUsage(dataRoot, id) {
  const store = readStore(dataRoot);
  const account = store.accounts.find(item => item.id === id);
  if (!account) return null;
  const date = todayKey();
  if (account.videoUsageDate !== date) {
    account.videoUsageDate = date;
    account.videoUsageCount = 0;
  }
  account.videoUsageCount = Math.max(0, Number(account.videoUsageCount) || 0) + 1;
  account.updatedAt = new Date().toISOString();
  writeStore(dataRoot, store);
  return publicAccount(account);
}

module.exports = { PROVIDERS, list, upsert, parseDolaCredentialLines, importMany, remove, credential, updateQuota, incrementVideoUsage, todayKey };
