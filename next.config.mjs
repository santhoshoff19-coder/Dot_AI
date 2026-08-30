/** @type {import('next').NextConfig} */
const nextConfig = {
  // The local embedding model ships native ONNX binaries that webpack must not
  // attempt to bundle; they are loaded at runtime on the server instead.
  serverExternalPackages: [
    "@prisma/client", "prisma",
    "@xenova/transformers", "onnxruntime-node", "sharp",
  ],
};
export default nextConfig;
