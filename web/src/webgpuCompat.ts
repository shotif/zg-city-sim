/**
 * three.js r186 passes `swizzle: 'rgba'` to every GPUTexture.createView call. Some Chrome
 * releases implement an older draft in which `swizzle` is an object, and throw on the string.
 * 'rgba' is the identity swizzle, so dropping it changes nothing anywhere.
 */
export function installWebGpuCompat(): void {
  const gpuTexture = (globalThis as { GPUTexture?: { prototype: GpuTextureLike } }).GPUTexture;
  if (!gpuTexture) return;
  const proto = gpuTexture.prototype;
  const createView = proto.createView;
  if ((createView as { patched?: boolean }).patched) return;

  const patched = function (this: unknown, descriptor?: Record<string, unknown>) {
    if (descriptor && descriptor.swizzle === 'rgba') {
      const rest: Record<string, unknown> = {};
      for (const key of Object.keys(descriptor)) {
        if (key !== 'swizzle') rest[key] = descriptor[key];
      }
      return createView.call(this, rest);
    }
    return createView.call(this, descriptor);
  };
  (patched as { patched?: boolean }).patched = true;
  proto.createView = patched;
}

interface GpuTextureLike {
  createView: (this: unknown, descriptor?: Record<string, unknown>) => unknown;
}
