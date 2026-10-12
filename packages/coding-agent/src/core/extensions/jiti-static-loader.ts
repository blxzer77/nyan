// Bundled runtimes (the Node bundle, a Node single-executable build) need jiti's static entry so the
// bundler embeds the Babel transform. The module itself remains lazy until an extension is loaded.
export { createJiti } from "jiti/static";
