// Reviewed prototype -> static assets. Demo scripts/data and third-party fonts
// never enter the runnable Java UI. The source prototype remains untouched.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/prepare-java-ui.mjs <approved prototype.html>');
const source = fs.readFileSync(input, 'utf8'), style = source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
let body = source.match(/<body>([\s\S]*?)<script>/)?.[1];
if (!style || !body || !body.includes('id="libraryGrid"')) throw new Error('Unsupported prototype structure');
body = body.replace('style="position:absolute;width:0;height:0;overflow:hidden"', 'class="icon-definitions"').replace(/<div class="user-chip">[\s\S]*?<\/div>/, '<div class="user-chip" id="identity"><a class="user-link" href="#profile">用户中心</a></div>')
  .replace(/<span class="demo-role">[\s\S]*?<\/span>/, '')
  .replace(/<a href="#" class="small-link" data-demo="管理后台">管理后台<\/a>/, '<a href="#" class="small-link" id="adminLink" hidden>管理后台</a>')
  .replace(/<a class="nav-link nav-mobile-only" href="#" data-demo="管理后台">管理后台<\/a>/, '<a class="nav-link nav-mobile-only" href="#" id="mobileAdminLink" hidden>管理后台</a>')
  .replace(/<a class="nav-link nav-mobile-only" href="#" data-demo="退出登录">退出登录<\/a>/, '')
  .replace(/共 <strong>4<\/strong> 份题库/, '正在读取题库…')
  .replace('data-demo="联系管理员"', 'data-admin-contact');
const target = path.join(root, 'java-hub/src/main/resources/static'); fs.mkdirSync(target, { recursive: true });
const html = '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#f8f8fb"><title>发现题库 · QuizForge</title><link rel="icon" href="/quizforge-icon.png"><link rel="stylesheet" href="/hub.css"><link rel="stylesheet" href="/admin-contact.css"><link rel="stylesheet" href="/account.css"><script type="module" src="/hub.js"></script></head><body>' + body + '</body></html>\n';
fs.writeFileSync(path.join(target, 'index.html'), html);
fs.writeFileSync(path.join(target, 'hub.css'), style + '\n/* Runtime states; the approved responsive layout is retained. */\n.card-art .cover-fallback{display:grid;place-items:center;width:100%;height:100%;color:var(--accent);font-size:28px}.page-error{padding:24px;border:1px solid var(--line-strong);border-radius:16px;white-space:pre-wrap}.runtime-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.runtime-link{display:inline-flex;align-items:center;justify-content:center;min-height:40px}.runtime-pager{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:28px}.runtime-cover{padding:0;border:0;background:none;width:100%;cursor:zoom-in}.runtime-empty{padding:20px 0;color:var(--muted)}.intro-text{white-space:pre-wrap;overflow-wrap:anywhere}.hash code{overflow-wrap:anywhere}.card-title a{display:block}.runtime-status{margin:16px 0;color:var(--text)}\n');
for (const file of ['quizforge-icon.png', 'admin-contact.js', 'admin-contact.css']) fs.copyFileSync(path.join(root, 'practice/public', file), path.join(target, file));
fs.appendFileSync(path.join(target, 'hub.css'), '\n.icon-definitions{position:absolute;width:0;height:0;overflow:hidden}\n');
fs.writeFileSync(path.join(target, 'prototype-source.json'), JSON.stringify({ prototype: path.basename(input), sha256: createHash('sha256').update(source).digest('hex'), generatedBy: 'scripts/prepare-java-ui.mjs', demoDataIncluded: false }, null, 2) + '\n');
console.log('Prepared Java UI: approved styles/markup + real API adapter, without prototype demo data.');
