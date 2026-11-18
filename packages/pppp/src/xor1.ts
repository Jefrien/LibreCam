// Adapted for Node.js from devbis/aiopppp under Apache-2.0. See NOTICE.
// Ported from devbis/aiopppp aiopppp/encrypt.py (Apache-2.0).
const TABLE = Buffer.from(
  "7c9ce84a13dedcb22f2123e4307b3d8cbc0b270c3cf79ae7087196009785efc11fc4dba1c2ebd901faba3b05b81587832872d18b5ad6da9358feaacc6e1bf0a388ab43c00db545384f502266207f075b14981d9ba72ab9a8cbf1fc4947063eb10e043a945eee541134dd4df9ecc7c9e3781a6f706ba4bda95dd5f8e5bb26af4237d8e1020aae5f1cc573094e6924906d12b319ad748a2940f52dbea559e0f479d24bce8982488425c6912ba2fb8fe9a6b09e3f65f603312eac0f952c5ced39b7336c567eb4a0fd7a815351868d9f77ff6a80dfe2bf10d775645776f355cdd0c818e6364162cf99f2324c67606192cad3ea637d16b68ed46835c3529d46441e17",
  "hex",
);
export const DEFAULT_KEY = [0x69, 0x97, 0xcc, 0x19] as const;
export function xor1Decode(
  input: Uint8Array,
  key: readonly number[] = DEFAULT_KEY,
): Buffer {
  let previous = 0;
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    const index = (key[previous & 3]! + previous) & 255;
    const cipher = input[i]!;
    out[i] = cipher ^ TABLE[index]!;
    previous = cipher;
  }
  return out;
}
export function xor1Encode(
  input: Uint8Array,
  key: readonly number[] = DEFAULT_KEY,
): Buffer {
  let previous = 0;
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i++) {
    const index = (key[previous & 3]! + previous) & 255;
    const cipher = input[i]! ^ TABLE[index]!;
    out[i] = cipher;
    previous = cipher;
  }
  return out;
}
