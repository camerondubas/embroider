import Plugin from "broccoli-plugin";
import { join } from 'path';
import {
  emptyDirSync,
  ensureSymlinkSync,
  ensureDirSync,
  realpathSync,
  mkdtempSync,
  copySync,
} from 'fs-extra';
import { Workspace, Package } from '@embroider/core';
import V1InstanceCache from "./v1-instance-cache";
import { tmpdir } from 'os';
import { MovedPackageCache } from "./moved-package-cache";
import { Memoize } from "typescript-memoize";
import buildCompatAddon from './build-compat-addon';
import WorkspaceOptions, { defaultOptions, WorkspaceOptionsWithDefaults } from './options';

export default class CompatWorkspace extends Plugin implements Workspace {
  private didBuild: boolean;
  private destDir: string;
  private packageCache: MovedPackageCache;

  constructor(legacyEmberAppInstance: object, maybeOptions?: WorkspaceOptions) {
    let options = Object.assign({}, defaultOptions(), maybeOptions) as WorkspaceOptionsWithDefaults;

    let destDir;
    if (options && options.workspaceDir) {
      ensureDirSync(options.workspaceDir);
      destDir = realpathSync(options.workspaceDir);
    } else {
      destDir = mkdtempSync(join(tmpdir(), 'embroider-'));
    }

    let v1Cache = V1InstanceCache.forApp(legacyEmberAppInstance, options);
    let packageCache = v1Cache.packageCache.moveAddons(v1Cache.app.root, destDir);
    let trees = [...packageCache.moved.keys()].map(oldPkg => buildCompatAddon(oldPkg, v1Cache));

    super(trees, {
      annotation: 'embroider:core:workspace',
      persistentOutput: true,
      needsCache: false
    });

    this.didBuild = false;
    this.packageCache = packageCache;
    this.destDir = destDir;
  }

  async ready(): Promise<{ appDestDir: string, app: Package }>{
    await this.deferReady.promise;
    return {
      appDestDir: this.packageCache.appDestDir,
      app: this.packageCache.app
    };
  }

  private get appDestDir(): string {
    return this.packageCache.appDestDir;
  }

  private get app(): Package {
    return this.packageCache.app;
  }

  async build() {
    if (this.didBuild) {
      // TODO: we can selectively allow some addons to rebuild, equivalent to
      // the old isDevelopingAddon.
      return;
    }

    emptyDirSync(this.destDir);

    [...this.packageCache.moved.values()].forEach((movedPkg, index) => {
      copySync(this.inputPaths[index], movedPkg.root, { dereference: true });
      this.linkNonCopiedDeps(movedPkg, movedPkg.root);
    });
    this.linkNonCopiedDeps(this.app, this.appDestDir);
    await this.packageCache.updatePreexistingResolvableSymlinks();
    this.didBuild = true;
    this.deferReady.resolve();
  }

  @Memoize()
  private get deferReady() {
    let resolve: Function;
    let promise: Promise<void> = new Promise(r => resolve =r);
    return { resolve: resolve!, promise };
  }

  @Memoize()
  private isMoved(pkg: Package) {
    for (let candidate of this.packageCache.moved.values()) {
      if (candidate === pkg) {
        return true;
      }
    }
    return false;
  }

  private linkNonCopiedDeps(pkg: Package, destRoot: string) {
    for (let dep of pkg.dependencies) {
      if (!this.isMoved(dep)) {
        ensureSymlinkSync(dep.root, join(destRoot, 'node_modules', dep.packageJSON.name));
      }
    }
  }
}