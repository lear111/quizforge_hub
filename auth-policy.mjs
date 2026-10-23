import { CloudError } from './cloud/accounts.mjs';

export const authPolicyDefaults = Object.freeze({ loginCodeRequired: false, loginCaptchaRequired: false, registrationCodeRequired: true, registrationCaptchaRequired: true });
export const authPolicyFields = [...Object.keys(authPolicyDefaults), 'invitationRequired'];

export function createAuthPolicy(db, invitationPolicy) {
  db.exec(`CREATE TABLE IF NOT EXISTS authentication_policy(id INTEGER PRIMARY KEY CHECK(id=1),login_code INTEGER NOT NULL,login_captcha INTEGER NOT NULL,registration_code INTEGER NOT NULL,registration_captcha INTEGER NOT NULL,revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO authentication_policy VALUES(1,0,0,1,1,0);`);
  const get = () => {
    const row = db.prepare('SELECT * FROM authentication_policy WHERE id=1').get();
    return { loginCodeRequired: !!row.login_code, loginCaptchaRequired: !!row.login_captcha, registrationCodeRequired: !!row.registration_code,
      registrationCaptchaRequired: !!row.registration_captcha, invitationRequired: invitationPolicy.required(), revision: row.revision };
  };
  return {
    get,
    set(input) {
      if (!db.isTransaction) throw new Error('Authentication policy changes require the audit transaction');
      if (!input || Object.keys(input).some(key => key !== 'revision' && !authPolicyFields.includes(key)) || !authPolicyFields.some(key => Object.hasOwn(input, key))
        || authPolicyFields.some(key => Object.hasOwn(input, key) && typeof input[key] !== 'boolean')) throw new CloudError(400, '验证选项必须明确设置为开启或关闭');
      const previous = get();
      if (input.revision !== undefined && (!Number.isSafeInteger(input.revision) || input.revision !== previous.revision)) throw new CloudError(409, '设置已被更新，请重新读取后再保存');
      const next = { ...previous, ...input };
      if (authPolicyFields.some(key => previous[key] !== next[key])) {
        invitationPolicy.setRequired(next.invitationRequired);
        db.prepare('UPDATE authentication_policy SET login_code=?,login_captcha=?,registration_code=?,registration_captcha=?,revision=revision+1 WHERE id=1')
          .run(+next.loginCodeRequired, +next.loginCaptchaRequired, +next.registrationCodeRequired, +next.registrationCaptchaRequired);
      }
      return { previous, replacement: get() };
    },
  };
}
