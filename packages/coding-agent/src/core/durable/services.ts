import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionServices,
} from "../agent-session-services.ts";
import type {
	ExtensionRuntime,
	InlineExtension,
	LoadExtensionsResult,
	ProjectTrustContext,
} from "../extensions/types.ts";
import { resolveProjectTrusted } from "../project-trust.ts";
import { SettingsManager } from "../settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../trust-manager.ts";

/** Resource options of the durable path: the flags that the legacy path reads, under the same meaning. */
export interface DurableResourceOptions {
	readonly extensionPaths?: readonly string[];
	readonly skillPaths?: readonly string[];
	readonly promptTemplatePaths?: readonly string[];
	readonly themePaths?: readonly string[];
	readonly noExtensions?: boolean;
	readonly noMcp?: boolean;
	readonly noSkills?: boolean;
	readonly noPromptTemplates?: boolean;
	readonly noThemes?: boolean;
	readonly noContextFiles?: boolean;
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
	/** `--trust` or `--no-trust`: decides project trust without asking. */
	readonly trustOverride?: boolean;
}

export interface DurableServicesOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly resources: DurableResourceOptions;
	/** Built-in and inline extensions; the caller decides which are on, as the legacy path does. */
	readonly extensionFactories: readonly InlineExtension[];
	readonly extensionFlagValues?: Map<string, boolean | string>;
	readonly projectTrustContext: ProjectTrustContext;
}

/** The cwd-bound services of the durable path, created with the same trust rules as the legacy runtime. */
export interface DurableServices extends AgentSessionServices {
	/** Diagnostics from loading and project trust, as the legacy runtime reports them. */
	readonly diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Model runtime, resource loader, and settings for one session directory. Provider registrations from extensions are
 * flushed into the model runtime here, as the legacy path does, so `--provider` resolves on the durable path. No
 * ExtensionRunner is bound: extension events and extension tools arrive with the extension adapter.
 */
export async function createDurableServices(options: DurableServicesOptions): Promise<DurableServices> {
	const { cwd, agentDir, resources } = options;
	const trustStore = new ProjectTrustStore(agentDir);
	const trustDiagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const trustRequired = hasTrustRequiringProjectResources(cwd);
	// Project trust is decided by the extensions' `project_trust` handlers, then the stored decision, then the prompt.
	// Until it is decided, project settings stay off, as in the legacy runtime (main.ts createRuntime).
	const resolveTrust = resources.trustOverride === undefined && trustRequired;
	const projectTrusted = resolveTrust
		? false
		: (resources.trustOverride ?? (!trustRequired || trustStore.get(cwd) === true));
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });

	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		modelRuntimeSignal: AbortSignal.timeout(15_000),
		extensionFlagValues: options.extensionFlagValues,
		resourceLoaderReloadOptions: resolveTrust
			? {
					resolveProjectTrust: async ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }) =>
						resolveProjectTrusted({
							cwd,
							trustStore,
							defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
							extensionsResult,
							projectTrustContext: options.projectTrustContext,
							onExtensionError: (message) => trustDiagnostics.push({ type: "warning", message }),
						}),
				}
			: undefined,
		resourceLoaderOptions: {
			additionalExtensionPaths: resources.extensionPaths ? [...resources.extensionPaths] : undefined,
			additionalSkillPaths: resources.skillPaths ? [...resources.skillPaths] : undefined,
			additionalPromptTemplatePaths: resources.promptTemplatePaths ? [...resources.promptTemplatePaths] : undefined,
			additionalThemePaths: resources.themePaths ? [...resources.themePaths] : undefined,
			extensionFactories: [...options.extensionFactories],
			noExtensions: resources.noExtensions,
			disabledBuiltinExtensions: resources.noMcp ? ["mcp"] : undefined,
			noSkills: resources.noSkills,
			noPromptTemplates: resources.noPromptTemplates,
			noThemes: resources.noThemes,
			noContextFiles: resources.noContextFiles,
			systemPrompt: resources.systemPrompt,
			appendSystemPrompt: resources.appendSystemPrompt ? [...resources.appendSystemPrompt] : undefined,
		},
	});

	const extensions = services.resourceLoader.getExtensions();
	bindProviderActions(services, extensions.runtime);
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [
		...trustDiagnostics,
		...services.diagnostics,
		...extensions.errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		})),
		...(extensions.warnings ?? []).map(({ path, warning }) => ({
			type: "warning" as const,
			message: `Extension package "${path}": ${warning}`,
		})),
	];
	return { ...services, diagnostics };
}

/**
 * Provider calls that an extension makes after loading, such as a catalog refresh that finishes later, reach the model
 * runtime directly. This is the provider part of `ExtensionRunner.bindCore()`, which the legacy path runs; the durable
 * path binds no runner, so without it those registrations would be queued and never applied.
 */
function bindProviderActions(services: AgentSessionServices, runtime: ExtensionRuntime): void {
	const models = services.modelRuntime;
	runtime.registerProvider = (name, config) => models.registerProvider(name, config);
	runtime.registerNativeProvider = (provider) => models.registerNativeProvider(provider);
	runtime.unregisterProvider = (name) => models.unregisterProvider(name);
	runtime.registerVirtualModel = (definition) => models.registerVirtualModel(definition);
	runtime.unregisterVirtualModel = (provider, id) => models.unregisterVirtualModel(provider, id);
}
