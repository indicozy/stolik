export const url = (p = '') => import.meta.env.BASE_URL.replace(/\/$/, '') + '/' + p.replace(/^\//, '');
