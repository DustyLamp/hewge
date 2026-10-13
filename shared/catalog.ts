export const piece = {
  id: 'toucan-001', name: 'After Hours', number: '001', collection: 'The Toucan Edition',
  price: 33900, currency: 'chf', material: 'Silk', edition: '1 of 1',
  image: '/images/shirt-front.webp', size: null as string | null,
};
export type PieceStatus = 'coming-soon' | 'available' | 'reserved' | 'sold';
export type Catalog = typeof piece & { status: PieceStatus; size: string | null };
