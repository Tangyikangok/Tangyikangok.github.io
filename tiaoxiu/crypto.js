/* ============================================================================
 *  crypto.js —— 浏览器端解密（WebCrypto）
 *  对应 airscript/crypto-aes.js 的 encryptJson：
 *    PBKDF2-HMAC-SHA256 派生 256 位密钥 → AES-256-CBC 解密
 *
 *  注意：WebCrypto 只在安全上下文可用（https:// 或 localhost）。
 *  GitHub Pages 是 https，满足条件；本地调试请用 http://localhost。
 * ========================================================================== */
(function () {
  'use strict';

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function isEncrypted(data) {
    return !!(data && typeof data === 'object' && data.ct && data.alg && data.salt && data.iv);
  }

  function available() {
    return !!(window.crypto && window.crypto.subtle);
  }

  /* 解密：成功返回明文字符串，口令错误或数据损坏时抛异常 */
  async function decrypt(pkg, password) {
    if (!available()) throw new Error('当前环境不支持 WebCrypto，请用 https 或 localhost 访问');
    if (!password) throw new Error('请输入口令');

    var enc = new TextEncoder();
    var salt = b64ToBytes(pkg.salt);
    var iv = b64ToBytes(pkg.iv);
    var ct = b64ToBytes(pkg.ct);
    var iter = pkg.iter || 100000;

    var keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']
    );
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-CBC', length: 256 },
      false,
      ['decrypt']
    );

    var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, ct);
    return new TextDecoder().decode(plainBuf);
  }

  window.TXCrypto = {
    isEncrypted: isEncrypted,
    decrypt: decrypt,
    available: available
  };
})();
