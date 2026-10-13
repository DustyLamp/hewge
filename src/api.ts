import { piece, type Catalog } from '../shared/catalog';
let config: Promise<{apiUrl:string}>;
async function base() {
 config ??= fetch('/config.json', { cache: 'no-cache' }).then(r => { if(!r.ok) throw Error('Configuration unavailable.'); return r.json(); });
 return (await config).apiUrl;
}
async function request(path:string, body?:unknown) {
 const url = await base();
 if (!url) throw Error('The guest list is not open yet. Come back shortly.');
 const response = await fetch(`${url}${path}`, { method: body ? 'POST':'GET', headers: {'Content-Type':'application/json'}, ...(body ? { body:JSON.stringify(body) }: {}), signal: AbortSignal.timeout(15000) });
 const data = await response.json();
 if (!response.ok) throw Error(data.message || 'Something went wrong. Please try again.');
 return data;
}
export async function getCatalog():Promise<Catalog> {
 if (!(await base())) return { ...piece, status:'coming-soon' };
 return request('/catalog');
}
export const joinList = (email:string, website:string) => request('/waitlist', { email, website, consent:true });
export const leaveList = (email:string) => request('/waitlist/remove', { email });
export const beginCheckout = () => request('/checkout', { productId:piece.id });
