# Asset provenance

The seven files in `originals/` are the user-supplied, approved painted mockup and print panel proofs. They are preserved unchanged. WebP files in `public/images/` are resized/encoded copies, reproducible with `npm run assets`.

`shirt-front-cutout.png` was created with the built-in imagegen tool from `originals/00-approved-painted-mockup.png`. It is a web presentation asset; the unmodified approved mockup remains the design reference in the gallery. Generated cutouts can vary in small printed details and must not be used as manufacturing artwork.

Final prompt:

> Use case: background-extraction. Asset type: Hewge luxury silk shirt website hero product cutout. Edit target: the attached approved shirt mockup. Extract ONLY the FRONT VIEW shirt (the shirt on the LEFT of the reference) into a single high resolution transparent PNG. Preserve the exact garment shape, collar, buttons, rich foliage, toucans and placement of every original printed scene; do not redesign or reinterpret any artwork. Remove the entire background and remove the back-view shirt on the right. Center the complete isolated front shirt upright, fill 90 percent of canvas height, leave modest transparent padding all around; no cropping of sleeves or hem. Genuine alpha transparency everywhere outside garment. No text, no props, no added shadow, no hanger, no person. Keep the original soft realistic silk shading and original colors.

Output source copied from the tool’s generated-images folder into this repository. Final optimized hero: `public/images/shirt-front.webp`.
