declare module '@jungherz-de/glasskit/glasskit-droplet.js' {
  export function attachDroplets(root?: Document | ShadowRoot | HTMLElement): () => void;
  export function attachDroplet(
    row: HTMLElement
  ): { update: () => void; destroy: () => void } | undefined;
}