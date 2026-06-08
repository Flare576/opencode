import { test, expect, describe, beforeEach, afterEach } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Config, getConfigStop, isBoundaryMoreRestrictive } from "@/config/config"
import { Env } from "@/env"
import { InstanceRuntime } from "@/project/instance-runtime"
import { testEffect } from "../lib/effect"
import { tmpdirScoped, testInstanceStoreLayer, provideInstanceEffect, TestInstance } from "../fixture/fixture"
import { AuthTest } from "../fake/auth"
import { AccountTest } from "../fake/account"
import { NpmTest } from "../fake/npm"
import { HttpClient } from "effect/unstable/http"
import path from "path"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const unexpectedHttp = HttpClient.make((request) =>
  Effect.die(`unexpected http request: ${request.method} ${request.url}`),
)

const buildConfigLayer = () =>
  Config.layer.pipe(
    Layer.provide(EffectFlock.defaultLayer),
    Layer.provide(Env.defaultLayer),
    Layer.provide(AuthTest.empty),
    Layer.provide(AccountTest.empty),
    Layer.provideMerge(infra),
    Layer.provide(NpmTest.noop),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, unexpectedHttp)),
    Layer.provideMerge(FSUtil.defaultLayer),
  )

const layer = buildConfigLayer()
const it = testEffect(layer)

const writeConfigEffect = (dir: string, config: object, name = "opencode.json") =>
  FSUtil.use.writeWithDirs(path.join(dir, name), JSON.stringify(config))

const withGlobalConfigDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const previous = Global.Path.config
      ;(Global.Path as { config: string }).config = dir
      yield* Config.use.invalidate().pipe(Effect.scoped, Effect.provide(layer))
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.gen(function* () {
        ;(Global.Path as { config: string }).config = previous
        yield* Config.use.invalidate().pipe(Effect.scoped, Effect.provide(layer))
      }),
  )

const withInstanceDir = <A, E, R>(dir: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(TestInstance, { directory: dir }),
    provideInstanceEffect(dir),
    Effect.provide(testInstanceStoreLayer),
    Effect.provide(CrossSpawnSpawner.defaultLayer),
  )

const withProcessEnv = <A, E, R>(key: string, value: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = process.env[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
      return original
    }),
    () => effect,
    (original) =>
      Effect.sync(() => {
        if (original !== undefined) process.env[key] = original
        else delete process.env[key]
      }),
  )

const schemaConfig = (config: object) => ({ $schema: "https://opencode.ai/config.json", ...config })

const invalidate = () =>
  Effect.runPromise(Config.use.invalidate().pipe(Effect.scoped, Effect.provide(layer)))

beforeEach(() => invalidate())
afterEach(async () => {
  await InstanceRuntime.disposeAllInstances()
  await invalidate()
})

describe("getConfigStop", () => {
  describe('"none"', () => {
    test("returns directory when directory is provided", () => {
      expect(getConfigStop("none", "/worktree", "/some/dir")).toBe("/some/dir")
    })

    test("falls back to worktree when directory is undefined", () => {
      expect(getConfigStop("none", "/worktree", undefined)).toBe("/worktree")
    })

    test("falls back to / when both directory and worktree are undefined", () => {
      expect(getConfigStop("none", undefined, undefined)).toBe("/")
    })

    test("returns the launch directory, not the git root", () => {
      expect(getConfigStop("none", "/project/root", "/project/root/src/components")).toBe(
        "/project/root/src/components",
      )
    })
  })

  describe('"home"', () => {
    test("returns Global.Path.home regardless of worktree and directory", () => {
      expect(getConfigStop("home", "/some/worktree", "/some/dir")).toBe(Global.Path.home)
    })

    test("returns Global.Path.home even when worktree and directory are undefined", () => {
      expect(getConfigStop("home", undefined, undefined)).toBe(Global.Path.home)
    })
  })

  describe('"root"', () => {
    test("returns /", () => {
      expect(getConfigStop("root", "/some/worktree", "/some/dir")).toBe("/")
    })

    test("returns / even when worktree and directory are undefined", () => {
      expect(getConfigStop("root", undefined, undefined)).toBe("/")
    })
  })

  describe('"current"', () => {
    test("returns worktree when provided", () => {
      expect(getConfigStop("current", "/my/worktree", "/my/worktree/subdir")).toBe("/my/worktree")
    })

    test("falls back to / when worktree is undefined", () => {
      expect(getConfigStop("current", undefined, "/some/dir")).toBe("/")
    })
  })

  describe("undefined boundary", () => {
    test("behaves as current — returns worktree", () => {
      expect(getConfigStop(undefined, "/my/worktree", "/my/worktree/sub")).toBe("/my/worktree")
    })

    test("behaves as current — falls back to / when no worktree", () => {
      expect(getConfigStop(undefined, undefined, "/some/dir")).toBe("/")
    })
  })

  describe("OPENCODE_CONFIG_BOUNDARY env var", () => {
    test("env none overrides home config field — returns directory not $HOME", () =>
      Effect.runPromise(
        withProcessEnv(
          "OPENCODE_CONFIG_BOUNDARY",
          "none",
          Effect.sync(() => {
            const result = getConfigStop("home", "/worktree", "/some/dir")
            expect(result).toBe("/some/dir")
            expect(result).not.toBe(Global.Path.home)
          }),
        ),
      ))

    test("env home overrides none config field — returns $HOME not directory", () =>
      Effect.runPromise(
        withProcessEnv(
          "OPENCODE_CONFIG_BOUNDARY",
          "home",
          Effect.sync(() => {
            expect(getConfigStop("none", "/worktree", "/some/dir")).toBe(Global.Path.home)
          }),
        ),
      ))

    test("unset env var — config field wins for all values", () =>
      Effect.runPromise(
        withProcessEnv(
          "OPENCODE_CONFIG_BOUNDARY",
          undefined,
          Effect.sync(() => {
            expect(getConfigStop("home", "/worktree", "/some/dir")).toBe(Global.Path.home)
            expect(getConfigStop("root", "/worktree", "/some/dir")).toBe("/")
            expect(getConfigStop("current", "/worktree", "/some/dir")).toBe("/worktree")
          }),
        ),
      ))
  })
})

describe("isBoundaryMoreRestrictive", () => {
  describe("none is most restrictive", () => {
    test("none < current", () => expect(isBoundaryMoreRestrictive("none", "current")).toBe(true))
    test("none < home", () => expect(isBoundaryMoreRestrictive("none", "home")).toBe(true))
    test("none < root", () => expect(isBoundaryMoreRestrictive("none", "root")).toBe(true))
  })

  describe("current is more restrictive than home and root", () => {
    test("current < home", () => expect(isBoundaryMoreRestrictive("current", "home")).toBe(true))
    test("current < root", () => expect(isBoundaryMoreRestrictive("current", "root")).toBe(true))
  })

  describe("home is more restrictive than root", () => {
    test("home < root", () => expect(isBoundaryMoreRestrictive("home", "root")).toBe(true))
  })

  describe("equal values are not more restrictive", () => {
    test("none vs none", () => expect(isBoundaryMoreRestrictive("none", "none")).toBe(false))
    test("current vs current", () => expect(isBoundaryMoreRestrictive("current", "current")).toBe(false))
    test("home vs home", () => expect(isBoundaryMoreRestrictive("home", "home")).toBe(false))
    test("root vs root", () => expect(isBoundaryMoreRestrictive("root", "root")).toBe(false))
  })

  describe("expansion attempts return false", () => {
    test("home is NOT more restrictive than current", () =>
      expect(isBoundaryMoreRestrictive("home", "current")).toBe(false))
    test("root is NOT more restrictive than current", () =>
      expect(isBoundaryMoreRestrictive("root", "current")).toBe(false))
    test("root is NOT more restrictive than none", () =>
      expect(isBoundaryMoreRestrictive("root", "none")).toBe(false))
    test("home is NOT more restrictive than none", () =>
      expect(isBoundaryMoreRestrictive("home", "none")).toBe(false))
    test("current is NOT more restrictive than none", () =>
      expect(isBoundaryMoreRestrictive("current", "none")).toBe(false))
  })

  describe("undefined treated as current", () => {
    test("undefined vs undefined — not more restrictive", () =>
      expect(isBoundaryMoreRestrictive(undefined, undefined)).toBe(false))
    test("undefined vs root — more restrictive (current < root)", () =>
      expect(isBoundaryMoreRestrictive(undefined, "root")).toBe(true))
    test("none vs undefined — more restrictive (none < current)", () =>
      expect(isBoundaryMoreRestrictive("none", undefined)).toBe(true))
    test("root vs undefined — NOT more restrictive (root > current)", () =>
      expect(isBoundaryMoreRestrictive("root", undefined)).toBe(false))
  })
})

describe("config traversal boundary integration", () => {
  it.live("global none — only launch directory config is loaded, ancestors ignored", () =>
    Effect.gen(function* () {
      const globalDir = yield* tmpdirScoped()
      const parentDir = yield* tmpdirScoped()
      const childDir = path.join(parentDir, "child")
      const grandchildDir = path.join(childDir, "grandchild")

      yield* writeConfigEffect(globalDir, schemaConfig({ configBoundary: "none" }))
      yield* writeConfigEffect(parentDir, schemaConfig({ username: "parent-level" }))
      yield* writeConfigEffect(childDir, schemaConfig({ username: "child-level" }))
      yield* writeConfigEffect(grandchildDir, schemaConfig({ username: "grandchild-level" }))

      return yield* withGlobalConfigDir(
        globalDir,
        withInstanceDir(
          grandchildDir,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.username).toBe("grandchild-level")
          }),
        ),
      )
    }),
  )

  it.live("mid-chain none stops traversal — ancestors above the declaring config are not loaded", () =>
    Effect.gen(function* () {
      const globalDir = yield* tmpdirScoped()
      const grandparentDir = yield* tmpdirScoped()
      const parentDir = path.join(grandparentDir, "parent")
      const childDir = path.join(parentDir, "child")
      const grandchildDir = path.join(childDir, "grandchild")

      yield* writeConfigEffect(globalDir, schemaConfig({ configBoundary: "home" }))
      yield* writeConfigEffect(grandparentDir, schemaConfig({ username: "grandparent-level" }))
      yield* writeConfigEffect(parentDir, schemaConfig({ configBoundary: "none", username: "parent-stops-here" }))
      yield* writeConfigEffect(childDir, schemaConfig({ username: "child-level" }))
      yield* writeConfigEffect(grandchildDir, schemaConfig({ username: "grandchild-level" }))

      return yield* withGlobalConfigDir(
        globalDir,
        withInstanceDir(
          grandchildDir,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.username).toBe("parent-stops-here")
          }),
        ),
      )
    }),
  )

  it.live("the config that declares none is itself loaded — its settings are included", () =>
    Effect.gen(function* () {
      const globalDir = yield* tmpdirScoped()
      const parentDir = yield* tmpdirScoped()
      const childDir = path.join(parentDir, "child")

      yield* writeConfigEffect(globalDir, schemaConfig({ configBoundary: "home" }))
      yield* writeConfigEffect(parentDir, schemaConfig({ configBoundary: "none", username: "stop-here" }))
      yield* writeConfigEffect(childDir, schemaConfig({ username: "child-level" }))

      return yield* withGlobalConfigDir(
        globalDir,
        withInstanceDir(
          childDir,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.username).toBe("stop-here")
          }),
        ),
      )
    }),
  )

  it.live("local config declaring root cannot expand beyond global none", () =>
    Effect.gen(function* () {
      const globalDir = yield* tmpdirScoped()
      const parentDir = yield* tmpdirScoped()
      const childDir = path.join(parentDir, "child")
      const grandchildDir = path.join(childDir, "grandchild")

      yield* writeConfigEffect(globalDir, schemaConfig({ configBoundary: "none" }))
      yield* writeConfigEffect(grandchildDir, schemaConfig({ configBoundary: "root", username: "grandchild-level" }))
      yield* writeConfigEffect(childDir, schemaConfig({ username: "child-level" }))
      yield* writeConfigEffect(parentDir, schemaConfig({ username: "parent-level" }))

      return yield* withGlobalConfigDir(
        globalDir,
        withInstanceDir(
          grandchildDir,
          Effect.gen(function* () {
            const config = yield* Config.use.get()
            expect(config.username).toBe("grandchild-level")
          }),
        ),
      )
    }),
  )

  it.live("global home — configs between launch dir and $HOME are loaded, above $HOME are not", () =>
    Effect.gen(function* () {
      const fakeHome = yield* tmpdirScoped()
      const globalDir = path.join(fakeHome, ".config", "opencode")
      const clientDir = path.join(fakeHome, "Projects", "ClientA")
      const projectDir = path.join(clientDir, "repo")

      yield* writeConfigEffect(globalDir, schemaConfig({ configBoundary: "home" }))
      yield* writeConfigEffect(clientDir, schemaConfig({ username: "client-level" }))
      yield* writeConfigEffect(projectDir, schemaConfig({ username: "project-level" }))

      return yield* withProcessEnv(
        "OPENCODE_TEST_HOME",
        fakeHome,
        withGlobalConfigDir(
          globalDir,
          withInstanceDir(
            projectDir,
            Effect.gen(function* () {
              const config = yield* Config.use.get()
              expect(config.username).toBe("client-level")
            }),
          ),
        ),
      )
    }),
  )
})
