const names = ['enabled', 'autoGrade', 'useOfficial', 'useCustom'];
const off = () => Object.fromEntries(names.map(name => [name, false]));

// Only a first visit gets defaults. An explicit saved choice always wins.
export function readCloudAiPrefs(storage, accountId) {
  if (!accountId) return off();
  try {
    const raw = storage.getItem(`qfh.ai.prefs.v1:${accountId}`);
    if (raw !== null) {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return off();
      return Object.fromEntries(names.map(name => [name, value[name] === true]));
    }
    const legacy = storage.getItem(`qfh.ai.v1:${accountId}`);
    if (legacy !== null) {
      const value = JSON.parse(legacy);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return off();
      return { enabled: value.enabled !== false, autoGrade: value.autoGrade === true, useOfficial: false, useCustom: true };
    }
    return { enabled: true, autoGrade: true, useOfficial: true, useCustom: false };
  } catch { return off(); }
}
