const ACCESS_KEY = 'lux-next:access-code:v1';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function readAccessCode(getStore: () => Store = () => localStorage): { remember: boolean; token: string } {
  try {
    const saved = JSON.parse(getStore().getItem(ACCESS_KEY) || 'null');
    return saved?.remember === true && typeof saved.token === 'string' && saved.token.length <= 512
      ? { remember: true, token: saved.token } : { remember: false, token: '' };
  } catch { return { remember: false, token: '' }; }
}
export function saveAccessCode(remember: boolean, token: string, getStore: () => Store = () => localStorage): boolean {
  try {
    const storage = getStore();
    if (remember) storage.setItem(ACCESS_KEY, JSON.stringify({ remember: true, token }));
    else storage.removeItem(ACCESS_KEY);
    return true;
  } catch { return false; }
}
