/**
 * Worker entry for the codemode sandbox in the Node bundle. The bundle builds this file as a
 * separate entrypoint because nyan-codemode's own worker file is not on disk there;
 * `getCodemodeWorkerSpecifier()` in config.ts resolves it.
 */
import "@ny4n/codemode/worker";
