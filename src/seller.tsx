import { seller } from "../shared/seller";

export function SellerDetails() {
  return (
    <address className="seller-details">
      <strong>
        {seller.name} · {seller.form}
      </strong>
      {seller.street}
      <br />
      {seller.postalCode} {seller.locality}
      <br />
      {seller.country}
      <br />
      <a href={`mailto:${seller.email}`}>{seller.email}</a>
    </address>
  );
}
