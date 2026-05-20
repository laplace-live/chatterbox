// ==UserScript==
// @name         B站独轮车 + 自动跟车 / Bilibili Live Auto Follow
// @namespace    https://github.com/aijc123/bilibili-live-wheel-auto-follow
// @version      2.14.1
// @author       aijc123
// @description  替你说，替你看 —— 给每天泡 B 站直播、在弹幕里特别活跃的观众。独轮车循环 / 自动跟车 / 手动发送 + AI 润色 / 影子屏蔽自动改写 / Chatterbox Chat 接管评论区 / 粉丝牌禁言巡检 / 同传 + 烂梗库。
// @license      AGPL-3.0
// @icon         https://www.bilibili.com/favicon.ico
// @homepage     https://aijc123.github.io/bilibili-live-wheel-auto-follow/
// @homepageURL  https://aijc123.github.io/bilibili-live-wheel-auto-follow/
// @website      https://aijc123.github.io/bilibili-live-wheel-auto-follow/
// @source       https://github.com/aijc123/bilibili-live-wheel-auto-follow
// @supportURL   https://github.com/aijc123/bilibili-live-wheel-auto-follow/issues
// @match        *://live.bilibili.com/*
// @require      https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/system.min.js
// @require      https://cdn.jsdelivr.net/npm/systemjs@6.15.1/dist/extras/named-register.min.js
// @require      data:application/javascript,%3B(typeof%20System!%3D'undefined')%26%26(System%3Dnew%20System.constructor())%3B
// @connect      bilibili-guard-room.vercel.app
// @connect      localhost
// @connect      sbhzm.cn
// @connect      chatterbox-cloud.aijc-eric.workers.dev
// @connect      live-meme-radar.aijc-eric.workers.dev
// @connect      api.anthropic.com
// @connect      api.openai.com
// @connect      *
// @grant        GM_addStyle
// @grant        GM_deleteValue
// @grant        GM_getValue
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==