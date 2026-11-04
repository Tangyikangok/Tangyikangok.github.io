/* ============================================================================
 *  crypto.js —— 浏览器端解密（WebCrypto）
 *  兼容两种数据格式：
 *    v1：单一密文包 {v:1, iter, salt, iv, ct}（旧版，总密码）
 *    v2：每人一份 {v:2, nameSalt, iter, admin:{iter,salt,iv,ct}, people:[{id,salt,iv,ct}]}
 *
 *  注意：WebCrypto 只在安全上下文可用（https:// 或 localhost）。
 * ========================================================================== */
(function () {
  'use strict';

  var enc = new TextEncoder();

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function isEncrypted(data) {
    return !!(data && typeof data === 'object' && data.ct && data.alg && data.salt && data.iv);
  }

  function isV2(data) {
    return !!(data && data.v === 2 && Array.isArray(data.people) && data.nameSalt && data.admin);
  }

  function available() {
    return !!(window.crypto && window.crypto.subtle);
  }

  async function sha256Hex(str) {
    var buf = await crypto.subtle.digest('SHA-256', enc.encode(str));
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) {
      var h = bytes[i].toString(16);
      s += h.length === 1 ? '0' + h : h;
    }
    return s;
  }

  /* 通用解密：pkg 需含 salt / iv / ct；iterations 由调用方给出 */
  async function decryptPkg(pkg, password, iterations) {
    if (!available()) throw new Error('当前环境不支持 WebCrypto，请用 https 或 localhost 访问');
    if (!password) throw new Error('请输入密码');

    var salt = b64ToBytes(pkg.salt);
    var iv = b64ToBytes(pkg.iv);
    var ct = b64ToBytes(pkg.ct);

    var keyMaterial = await crypto.subtle.importKey(
      'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    var key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iterations || 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-CBC', length: 256 },
      false,
      ['decrypt']
    );
    var plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv }, key, ct);
    return new TextDecoder().decode(plainBuf);
  }

  /* v1：单包解密 */
  async function decrypt(pkg, password) {
    return decryptPkg(pkg, password, pkg.iter || 100000);
  }

  /* v2：管理员全量解密 */
  async function decryptAdmin(data, password) {
    return decryptPkg(data.admin, password, (data.admin && data.admin.iter) || 100000);
  }

  /* v2：按姓名定位人员密文（找不到返回 null） */
  async function findPerson(data, name) {
    var id = await sha256Hex('tx|' + name + '|' + data.nameSalt);
    var list = data.people || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* v2：解密某个人的那一份 */
  async function decryptPerson(entry, password, iterations) {
    return decryptPkg(entry, password, iterations || 5000);
  }

  window.TXCrypto = {
    isEncrypted: isEncrypted,
    isV2: isV2,
    available: available,
    sha256Hex: sha256Hex,
    decrypt: decrypt,
    decryptAdmin: decryptAdmin,
    decryptPerson: decryptPerson,
    findPerson: findPerson
  };
})();
