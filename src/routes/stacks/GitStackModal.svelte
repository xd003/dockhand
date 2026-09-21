<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { appSettings } from '$lib/stores/settings';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Loader2, GitBranch, RefreshCw, Webhook, Rocket, RefreshCcw, Copy, Check, XCircle, FolderGit2, Github, Key, KeyRound, Lock, FileText, HelpCircle, GripVertical, X, Download, Hammer, ArrowDownToLine, Zap, FolderOpen, Ban, TriangleAlert, Settings2, Archive, History, GitFork, ArrowUp, ArrowDown, Code, GitGraph } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { page } from '$app/stores'; // BETA GATE: backups feature flag
	import BackupPanel from '../containers/BackupPanel.svelte';
	import DeploysPanel from './DeploysPanel.svelte';
	import { volumesForStack, type VolumeInfo } from '$lib/utils/mounts';
	import { fetchBackupExecutions } from '$lib/utils/backup';
	import { deployTallyFromRuns } from '$lib/utils/deploy-run-view';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import type { VariableMarker } from '$lib/components/CodeEditor.svelte';
	import SecretProviderPicker from '$lib/components/SecretProviderPicker.svelte';
	import BranchCombobox from './BranchCombobox.svelte';
	import IconPickerModal from './IconPickerModal.svelte';
	import ComposeOutputModal from './ComposeOutputModal.svelte';
	import StackIcon from '$lib/components/StackIcon.svelte';
	import StackTagsSection from '$lib/components/StackTagsSection.svelte';
	import { appendEnvParam } from '$lib/stores/environment';
	import { persistStackIcon } from '$lib/utils/stack-icon';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import { mergeGitStackEnvVars, isGitStackOverride } from '$lib/env-merge';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import FilesystemBrowser from './FilesystemBrowser.svelte';
	import StackFileEditor from './StackFileEditor.svelte';
	import type { StackEditorEntry, StackFileEditorDraft } from '$lib/stack-file-editor';
	import type { LinkedStackFile } from '$lib/stack-linked-files';
	import WebhookSecretInput from '$lib/components/WebhookSecretInput.svelte';
	import WebhookUrlCopyField from '$lib/components/WebhookUrlCopyField.svelte';
	import { ensureWebhookSecret, webhookSecretValidationError } from '$lib/utils/webhook-secret';
	import { startJobPolling, type JobPollingHandle } from '$lib/utils/job-polling';
	import { detectedComposeOverridePaths } from '$lib/compose-overrides';
	import { saveCloseTiming } from '$lib/utils/save-close-policy';


	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-git-stack-modal-split';
	const DEPLOY_SUCCESS_CLOSE_DELAY_MS = 1500;

	interface GitCredential {
		id: number;
		name: string;
		authType: string;
	}

	function getAuthLabel(authType: string) {
		switch (authType) {
			case 'ssh': return 'SSH Key';
			case 'password': return 'Password';
			default: return 'None';
		}
	}

	interface GitRepository {
		id: number;
		name: string;
		url: string;
		branch: string;
		credentialId: number | null;
	}

	interface GitStack {
		id: number;
		stackName: string;
		repositoryId: number;
		branch?: string | null; // Per-stack branch override; null = use repository default
		environmentId: number | null;
		composePath: string;
		composePaths: string | null;
		envFilePath: string | null;
		contextDir: string | null;
		buildOnDeploy: boolean;
		noBuildCache: boolean;
		repullImages: boolean;
		forceRedeploy: boolean;
		webhookEnabled: boolean;
		webhookSecret: string | null;
		engine?: 'stack' | 'centralized';
		// Stack-level scheduled sync (deprecated in centralized mode)
		autoUpdate?: boolean;
		autoUpdateSchedule?: string | null;
		autoUpdateCron?: string | null;
	}

	interface Props {
		open: boolean;
		gitStack?: GitStack | null;
		environmentId?: number | null;
		icon?: string | null;
		repositories: GitRepository[];
		credentials: GitCredential[];
		onClose: () => void;
		onSaved: () => void;
		onOpenStackView?: (tab: 'editor' | 'graph') => void;
		/** Existing external stack being intentionally converted to Git. */
		adoptionTarget?: { stackName: string; environmentId: number | null; displayName?: string; envPath?: string | null } | null;
		/** Called when a new repository is created inline (via Browse) so the parent can refresh the repos list */
		onRepositoryCreated?: () => void;
	}

	let { open = $bindable(), gitStack = null, adoptionTarget = null, environmentId = null, icon = null, repositories, credentials, onClose, onSaved, onOpenStackView, onRepositoryCreated }: Props = $props();
	const isAdopting = $derived(adoptionTarget !== null && gitStack === null);
	function openStackView(tab: 'editor' | 'graph') {
		onOpenStackView?.(tab);
	}

	// Per-stack icon override (same name-based /icon endpoint as internal stacks, #1473).
	let formIcon = $state<string | null>(icon);
	let showIconPicker = $state(false);
	$effect(() => { formIcon = icon; });

	// value: '' clear, 'upload:<dataUrl>' custom upload, or a lucide name / 'selfhst:<ref>'.
	async function onIconSelect(value: string) {
		if (!gitStack?.stackName) return;
		const target = appendEnvParam(`/api/stacks/${encodeURIComponent(gitStack.stackName)}/icon`, effectiveEnvId);
		try {
			const next = await persistStackIcon(target, value);
			if (next !== undefined) formIcon = next; // undefined = POST failed, keep current
			onSaved();
		} catch (e) {
			console.error('Failed to set stack icon:', e);
		}
	}

	// Form state - repository selection or creation
	let formRepoMode = $state<'existing' | 'new'>('existing');
	let formRepositoryId = $state<number | null>(null);
	let formNewRepoName = $state('');
	let formNewRepoUrl = $state('');
	let formNewRepoBranch = $state('main');
	let formNewRepoCredentialId = $state<number | null>(null);
	let formNewRepoAutoUpdate = $state(false);
	let formNewRepoAutoUpdateCron = $state('0 3 * * *');
	let formNewRepoWebhookEnabled = $state(false);
	let formNewRepoWebhookSecret = $state('');

	// Tabs: Settings (the deploy form), Deploys (recorded run history, edit mode),
	// and Backups (edit mode + feature flag only).
	let activeTab = $state<'settings' | 'editor' | 'deploys' | 'backups'>('settings');
	// Bumped after a deploy finishes so the Deploys tab re-fetches the new run.
	let deploysReloadKey = $state(0);
	// Deploys tab badge tally (total + ok/failed). Fetched cheaply when the modal
	// opens so the badge shows immediately; DeploysPanel's onTally keeps it fresh.
	let deploysTally = $state<{ total: number; ok: number; failed: number }>({ total: 0, ok: 0, failed: 0 });

	// Live compose output for "Save and deploy" (mirrors StackModal's deploy output;
	// shown in the shared ComposeOutputModal). Without this the streamed lines from
	// the deploy job are consumed and discarded, so the user sees no live output.
	let outputOpen = $state(false);
	let outputTitle = $state('');
	let outputLines = $state<string[]>([]);
	let outputRunning = $state(false);
	let outputOk = $state<boolean | undefined>(undefined);
	let outputMs = $state<number | undefined>(undefined);
	let outputExitCode = $state<number | undefined>(undefined);
	let outputStartedAt = 0;
	// The stack's volumes, loaded lazily when the Backups tab opens (git stacks
	// don't otherwise need them). Feeds the backup volume picker.
	let stackVolumes = $state<VolumeInfo[]>([]);
	let stackVolumesLoaded = $state(false);
	// Ok/fail run tally shown on the Backups tab (edit mode only).
	let backupTally = $state<{ ok: number; failed: number }>({ ok: 0, failed: 0 });
	let backupTallyLoaded = $state(false);
	const effectiveEnvId = $derived(gitStack?.environmentId ?? adoptionTarget?.environmentId ?? environmentId ?? null);

	async function loadBackupTally() {
		if (backupTallyLoaded || !gitStack) return;
		backupTallyLoaded = true;
		try {
			const p = new URLSearchParams({ target: formStackName, type: 'stack' });
			if (effectiveEnvId != null) p.set('env', String(effectiveEnvId));
			const res = await fetch(`/api/backup/configs?${p}`);
			if (!res.ok) return;
			const data = await res.json();
			const cfgs = Array.isArray(data) ? data : data?.id ? [data] : [];
			if (cfgs.length > 0) {
				const t = await fetchBackupExecutions(cfgs.map((c: any) => c.id));
				backupTally = { ok: t.ok, failed: t.failed };
			}
		} catch { /* tally is best-effort */ }
	}

	async function loadStackVolumes() {
		if (stackVolumesLoaded) return;
		stackVolumesLoaded = true;
		try {
			const url = effectiveEnvId != null ? `/api/containers?env=${effectiveEnvId}` : '/api/containers';
			const res = await fetch(url);
			if (res.ok) stackVolumes = volumesForStack(await res.json(), formStackName);
		} catch { /* picker just shows "no volumes" — backup still defaults to all */ }
	}

	// Load volumes the first time the Backups tab is opened.
	$effect(() => {
		if (activeTab === 'backups') void loadStackVolumes();
	});

	async function loadDeploysCount() {
		if (!gitStack) {
			deploysTally = { total: 0, ok: 0, failed: 0 };
			return;
		}
		try {
			const res = await fetch(appendEnvParam(`/api/stacks/${encodeURIComponent(gitStack.stackName)}/deploys`, effectiveEnvId));
			if (!res.ok) return;
			const data = await res.json();
			deploysTally = deployTallyFromRuns(Array.isArray(data?.runs) ? data.runs : []);
		} catch {
			// Non-fatal: the badge just stays at its current value.
		}
	}

	// Show the Deploys badge count as soon as the modal opens (not only once the tab
	// is viewed); re-count after a deploy bumps the key.
	$effect(() => {
		if (open) {
			void deploysReloadKey;
			void loadDeploysCount();
		}
	});

	// Form state - stack deployment config
	let formStackName = $state('');
	let formStackNameUserModified = $state(false);
	let formComposePath = $state('compose.yaml');
	let formComposePaths = $state<string[]>([]);
	let formContextDir = $state<string | null>(null);

	// Drag-and-drop state for compose paths reordering
	let gitDragIndex = $state<number | null>(null);

	function gitAddComposePath() {
		clearPreviewState();
		formComposePaths = [...formComposePaths, ''];
	}

	async function gitRemoveComposePath(index: number) {
		if (formComposePaths.length <= 1) return;
		clearPreviewState();
		const newPaths = formComposePaths.filter((_, i) => i !== index);
		formComposePaths = newPaths;
		if (index === 0) formComposePath = newPaths[0] || 'compose.yaml';
		if (!gitStack) await populateEnvVars();
	}

	function gitMovePathUp(index: number) {
		if (index <= 0) return;
		clearPreviewState();
		const newPaths = [...formComposePaths];
		[newPaths[index - 1], newPaths[index]] = [newPaths[index], newPaths[index - 1]];
		formComposePaths = newPaths;
		if (index - 1 === 0) formComposePath = newPaths[0];
	}

	function gitMovePathDown(index: number) {
		if (index >= formComposePaths.length - 1) return;
		clearPreviewState();
		const newPaths = [...formComposePaths];
		[newPaths[index], newPaths[index + 1]] = [newPaths[index + 1], newPaths[index]];
		formComposePaths = newPaths;
		if (index === 0) formComposePath = newPaths[0];
	}

	function gitDragStart(e: DragEvent, index: number) {
		gitDragIndex = index;
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = 'move';
			e.dataTransfer.setData('text/plain', String(index));
		}
	}

	function gitDragOver(e: DragEvent, index: number) {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		if (gitDragIndex === null || gitDragIndex === index) return;
		clearPreviewState();
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const before = e.clientY < rect.top + rect.height / 2;
		const targetIndex = before ? index : index + 1;
		const newPaths = [...formComposePaths];
		const [moved] = newPaths.splice(gitDragIndex, 1);
		const insertAt = gitDragIndex < targetIndex ? targetIndex - 1 : targetIndex;
		newPaths.splice(insertAt, 0, moved);
		formComposePaths = newPaths;
		gitDragIndex = insertAt;
		if (insertAt === 0) formComposePath = newPaths[0];
	}

	function gitDragEnd() {
		gitDragIndex = null;
	}

	let gitBrowseForRowIndex = $state<number | null>(null);
	let gitBrowserPurpose = $state<'compose' | 'link'>('compose');
	let gitBrowserInitialPath = $state('');

	async function gitBrowseForRow(index: number) {
		gitBrowserError = null;
		gitBrowserPurpose = 'compose';
		gitBrowserInitialPath = '';
		gitBrowseForRowIndex = index;
		await openGitRepoBrowser();
	}

	async function gitHandleRowBrowseSelect(absolutePath: string) {
		if (gitBrowseForRowIndex === null) return;
		clearPreviewState();
		const capturedIndex = gitBrowseForRowIndex;
		const relativePath = gitBrowserRootPath && absolutePath.startsWith(gitBrowserRootPath)
			? absolutePath.slice(gitBrowserRootPath.length).replace(/^\//, '')
			: absolutePath;
		const newPaths = [...formComposePaths];
		newPaths[capturedIndex] = relativePath;
		formComposePaths = newPaths;
		if (capturedIndex === 0) {
			formComposePath = relativePath;
			// Mark as browsed so the repo-name $effect no longer overrides the stack name
			formComposePathBrowsed = true;
			await addDetectedGitComposeOverrides(relativePath);
		}
		showGitRepoBrowser = false;
		gitBrowseForRowIndex = null;
		// Auto-derive stack name from parent directory if user hasn't typed one
		if (capturedIndex === 0 && !formStackNameUserModified) {
			const parts = relativePath.split('/');
			if (parts.length >= 2) {
				const parentDir = parts[parts.length - 2];
				formStackName = parentDir
					.toLowerCase()
					.replace(/[\s_]+/g, '-')
					.replace(/[^a-z0-9-]/g, '')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '');
			}
		}
		if (!gitStack) await loadGitDraftEditor();
	}

	async function addDetectedGitComposeOverrides(relativePath: string) {
		const slash = relativePath.lastIndexOf('/');
		const composeDir = slash < 0 ? '' : relativePath.slice(0, slash);
		try {
			const separator = gitBrowserApiUrl.includes('?') ? '&' : '?';
			const response = await fetch(`${gitBrowserApiUrl}${separator}path=${encodeURIComponent(composeDir)}`);
			if (!response.ok) return;
			const data = await response.json();
			const entries = Array.isArray(data.entries) ? data.entries : [];
			const overrides = detectedComposeOverridePaths(
				relativePath,
				entries.filter((entry: any) => entry.type !== 'directory').map((entry: any) => entry.name)
			);
			const composeNames = new Set([...formComposePaths, ...overrides].map((path) => path.split('/').pop()?.toLocaleLowerCase()));
			draftHasLinkableFile = entries.some((entry: any) =>
				entry.type !== 'directory' && entry.name.toLocaleLowerCase() !== '.env' && !composeNames.has(entry.name.toLocaleLowerCase())
			);
			if (overrides.length === 0 || formComposePaths[0] !== relativePath) return;
			const rest = formComposePaths.slice(1).filter((path) => !overrides.includes(path));
			formComposePaths = [relativePath, ...overrides, ...rest];
		} catch (e) {
			console.warn('Failed to detect Git compose overrides:', e);
		}
	}

	function configureGitBrowser() {
		if (!formRepositoryId) return;
		const params = new URLSearchParams();
		if (gitStack?.engine === 'stack' && formRepositoryId === gitStack.repositoryId) {
			params.set('stackId', String(gitStack.id));
		}
		else if (!isCentralizedMode && temporaryCloneToken) params.set('pending', temporaryCloneToken);
		const query = params.toString();
		gitBrowserApiUrl = `/api/git/repositories/${formRepositoryId}/browse${query ? `?${query}` : ''}`;
		gitBrowserRootPath = '';
	}

	async function prepareTemporaryClone(repositoryId: number, branch?: string | null): Promise<boolean> {
		const effectiveBranch = branch?.trim() || null;
		if (
			temporaryCloneToken &&
			temporaryCloneRepositoryId === repositoryId &&
			(effectiveBranch === null || temporaryCloneBranch === effectiveBranch)
		) {
			configureGitBrowser();
			return true;
		}
		cloneStatus = 'cloning';
		cloneError = null;
		try {
			const response = await fetch(`/api/git/repositories/${repositoryId}/temporary-clone`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ branch: branch || undefined })
			});
			const data = await response.json();
			if (!response.ok || typeof data.token !== 'string') {
				throw new Error(data.error || 'Failed to clone repository');
			}
			temporaryCloneToken = data.token;
			temporaryCloneRepositoryId = repositoryId;
			temporaryCloneBranch = effectiveBranch;
			configureGitBrowser();
			cloneStatus = 'idle';
			return true;
		} catch (error) {
			cloneStatus = 'error';
			cloneError = error instanceof Error ? error.message : 'Failed to clone repository';
			return false;
		}
	}

	async function loadGitDraftEditor() {
		if (gitStack || !formRepositoryId) return;
		const seq = ++draftLoadSeq;
		if (!isCentralizedMode && !(await prepareTemporaryClone(formRepositoryId, formBranch || selectedRepo?.branch))) return;
		if (seq !== draftLoadSeq || (!isCentralizedMode && !temporaryCloneToken)) return;
		const paths = formComposePaths.map((path) => path.trim()).filter(Boolean);
		if (paths.length === 0) return;
		try {
			const query = new URLSearchParams(isCentralizedMode ? { shared: '1' } : { token: temporaryCloneToken! });
			for (const path of paths) query.append('path', path);
			const response = await fetch(`/api/git/repositories/${formRepositoryId}/draft-files?${query}`);
			const data = await response.json();
			if (seq !== draftLoadSeq) return;
			if (!response.ok) throw new Error(data.error || 'Failed to load Compose files');
			const entries = Array.isArray(data.entries) ? data.entries : [];
			const contents = Object.fromEntries(entries.map((entry: any) => [entry.path, entry.content]));
			draftComposeContents = contents;
			draftOriginalComposeContents = { ...contents };
			draftComposeRevisions = Object.fromEntries(entries.filter((entry: any) => typeof entry.revision === 'string').map((entry: any) => [entry.path, entry.revision]));
			draftComposeClassifications = entries.map((entry: any) => ({ path: entry.path, tracked: entry.tracked === true, ignored: entry.ignored === true }));
			draftLinkedEntries = [];
			draftFolders = [];
			draftEditorDirty = false;
			draftEditorReady = true;
			await populateEnvVars();
		} catch (error) {
			draftEditorReady = false;
			formError = error instanceof Error ? error.message : 'Failed to load Compose files';
		}
	}

	function applyGitDraftEditor(draft: StackFileEditorDraft) {
		formComposePaths = [...draft.composePaths];
		formComposePath = formComposePaths[0] || 'compose.yaml';
		draftComposeContents = { ...draft.composeContents };
		draftLinkedEntries = draft.linkedFiles.map((file) => {
			const previous = draftLinkedEntries.find((entry) => entry.path === file.path);
			return {
				path: file.path,
				name: file.path.split('/').pop() ?? file.path,
				kind: 'linked',
				content: draft.linkedFileContents[file.path] ?? previous?.content ?? '',
				originalContent: previous?.originalContent ?? '',
				language: file.path.includes('.') ? 'text' : 'text',
				ownership: file.ownership,
				tracked: draft.classifications.find((entry) => entry.path === file.path)?.tracked,
				ignored: draft.classifications.find((entry) => entry.path === file.path)?.ignored,
				postChange: file.postChange,
				originalPostChange: previous?.originalPostChange ?? structuredClone(file.postChange),
				revision: draft.revisions[file.path] ?? previous?.revision
			};
		});
		draftFolders = [...draft.createdFolders];
		draftEditorDirty = true;
		previewedComposePaths = [...draft.composePaths];
		previewedComposeContents = { ...draft.composeContents };
		previewedComposeContent = draft.composeContents[draft.composePaths[0]] ?? '';
	}

	async function requestGitDraftLink() {
		if (!formRepositoryId || (!isCentralizedMode && !temporaryCloneToken)) return;
		gitBrowserPurpose = 'link';
		gitBrowseForRowIndex = null;
		gitBrowserInitialPath = (formComposePaths[0] || formComposePath).replace(/\/[^/]*$/, '');
		configureGitBrowser();
		showGitRepoBrowser = true;
	}

	async function selectGitDraftLink(path: string) {
		if (!formRepositoryId || (!isCentralizedMode && !temporaryCloneToken)) return;
		const composeDir = (formComposePaths[0] || formComposePath).replace(/\/[^/]*$/, '');
		const relativePath = composeDir && path.startsWith(`${composeDir}/`) ? path.slice(composeDir.length + 1) : path;
		const query = new URLSearchParams(isCentralizedMode ? { shared: '1', path } : { token: temporaryCloneToken!, path });
		const response = await fetch(`/api/git/repositories/${formRepositoryId}/draft-files?${query}`);
		const data = await response.json().catch(() => ({}));
		if (!response.ok || !data.entries?.[0]) {
			toast.error(data.error || 'Failed to load configuration file');
			return;
		}
		const entry = data.entries[0];
		draftEditorRef?.addLinkedFile({ path: relativePath, content: entry.content, ownership: 'git', tracked: entry.tracked, ignored: entry.ignored, revision: entry.revision });
		showGitRepoBrowser = false;
	}

	let formBuildOnDeploy = $state(false);
	let formNoBuildCache = $state(false);
	let formRepullImages = $state(false);
	let formForceRedeploy = $state(false);
	let formStackWebhookEnabled = $state(false);
	let formStackWebhookSecret = $state('');
	// Stack-level scheduled sync
	let formStackAutoUpdate = $state(false);
	let formStackAutoUpdateSchedule = $state<'daily' | 'weekly' | 'custom'>('daily');
	let formStackAutoUpdateCron = $state('0 3 * * *');
	let formDeployNow = $state(false);
	let formError = $state('');
	let formSaving = $state(false);
	let showExistsWarning = $state(false);
	let errors = $state<{ stackName?: string; repository?: string; repoName?: string; repoUrl?: string; newRepoWebhookSecret?: string; stackWebhookSecret?: string; stackAutoUpdateCron?: string }>({});
	// Per-stack model: new stacks inherit the global DEFAULT (no chooser); editing
	// follows the stack's own engine. This drives which fields/contracts apply.
	const isCentralizedMode = $derived(
		gitStack ? (gitStack.engine === 'centralized') : ($appSettings.gitRepositoryDesiredMode === 'centralized')
	);
	const instanceDefaultLabel = $derived($appSettings.gitRepositoryDesiredMode === 'centralized'
		? 'centralized (shared clone)'
		: 'per-stack clones');
	let migrating = $state(false);

// Branch selection
	let formBranch = $state<string | null>(null);
	let branches = $state<{ name: string; sha: string }[]>([]);
	let branchesLoading = $state(false);
	// Monotonic token that guards against a stale branch-enumeration response
	// overwriting `branches` for a newer repository URL (the $effect below can
	// fire multiple times as the repo selection changes; a slow response for
	// repo A must not clobber the branch list belonging to repo B).
	let branchesFetchSeq = 0;

	// Sentinel select value meaning "no per-stack override — use the repository's
	// default branch". Contains ':' which is invalid in git refs, so it can never
	// collide with a real branch name.

	// Stack name validation: Docker Compose requires lowercase; must start with a
	// letter or number, and contain only lowercase letters, numbers, hyphens, underscores
	const STACK_NAME_REGEX = /^[a-z0-9][a-z0-9_-]*$/;
	let copiedWebhookUrl = $state<'ok' | 'error' | null>(null);
	let copiedWebhookSecret = $state<'ok' | 'error' | null>(null);

	async function migrateStack() {
		if (!gitStack || gitStack.engine !== 'stack') return;
		if (!window.confirm(
			`Migrate "${gitStack.stackName}" to centralized Git mode?\n\nThis stack will move onto the shared repository clone, its per-stack sync schedule and webhook URL may change, and the per-stack clone will be removed after the shared clone is ready. This only affects this stack.`
		)) return;
		migrating = true;
		try {
			const res = await fetch(`/api/git/stacks/${gitStack.id}/migrate`, { method: 'POST' });
			const data = await res.json();
			if (res.ok) {
				toast.success('Migration started for this stack');
				onSaved();
				onClose();
			} else {
				toast.error(data.error || 'Failed to start migration');
			}
		} catch {
			toast.error('Failed to start migration');
		} finally {
			migrating = false;
		}
	}

	// Secret providers
	type SecretProviderOption = { id: number; name: string; type: string };
	let secretProviders = $state<SecretProviderOption[]>([]);
	let formSecretProviderId = $state<number | null>(null);
	let injectedSecretKeys = $state<string[]>([]);

	// Environment variables state
	let formEnvFilePath = $state<string | null>(null);
	let envFiles = $state<string[]>([]);
	let loadingEnvFiles = $state(false);
	let envVars = $state<EnvVar[]>([]);
	let fileEnvVars = $state<Record<string, string>>({});
	let loadingFileVars = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());
	let populatingEnvVars = $state(false);
	let envValidation = $state<ValidationResult | null>(null);
	let previewedComposePaths = $state<string[]>([]);
	let previewedComposeContent = $state('');
	let previewedComposeContents = $state<Record<string, string>>({});
	let previewRequestSeq = 0;
	let envValidationSeq = 0;
	let skipNextEnvValidationEffect = false;
	const envVarMap = $derived(new Map(envVars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v])));
	const variableMarkers = $derived.by<VariableMarker[]>(() => {
		if (!envValidation) return [];

		return [
			...envValidation.missing.map((name) => ({
				name,
				type: 'missing' as const,
				value: envVarMap.get(name)?.value,
				isSecret: envVarMap.get(name)?.isSecret
			})),
			...envValidation.required.filter((name) => !envValidation!.missing.includes(name)).map((name) => ({
				name,
				type: 'required' as const,
				value: envVarMap.get(name)?.value,
				isSecret: envVarMap.get(name)?.isSecret
			})),
			...envValidation.optional.map((name) => ({
				name,
				type: 'optional' as const,
				value: envVarMap.get(name)?.value,
				isSecret: envVarMap.get(name)?.isSecret
			}))
		];
	});

	// Resizable split panel state
	let splitRatio = $state(60); // percentage for form panel
	// Mobile-only: which pane is shown (desktop uses the resizable split instead).
	let mobilePane: 'form' | 'vars' = $state('form');
	let isDraggingSplit = $state(false);
	let containerRef: HTMLDivElement | null = $state(null);


	// Git repository browse state
	let showGitRepoBrowser = $state(false);
	let showHostCopyBrowser = $state(false);
	let hostCopyPaths = $state<string[]>([]);
	let gitBrowserApiUrl = $state('');
	let gitBrowserRootPath = $state('');
	let gitBrowserCloningMessage = $state<string | undefined>(undefined);
	let gitBrowserError = $state<string | null>(null);
	let temporaryCloneToken = $state<string | null>(null);
	let temporaryCloneRepositoryId = $state<number | null>(null);
	let temporaryCloneBranch = $state<string | null>(null);
	let draftEditorRef = $state<StackFileEditor | null>(null);
	let draftEditorReady = $state(false);
	let draftHasLinkableFile = $state(false);
	let draftEditorDirty = $state(false);
	let draftComposeContents = $state<Record<string, string>>({});
	let draftOriginalComposeContents = $state<Record<string, string>>({});
	let draftComposeRevisions = $state<Record<string, string>>({});
	let draftComposeClassifications = $state<Array<{ path: string; tracked: boolean; ignored: boolean }>>([]);
	let draftLinkedEntries = $state<StackEditorEntry[]>([]);
	let draftFolders = $state<string[]>([]);
	let draftLoadSeq = 0;
	/** Tracks whether formComposePath was set by the Browse button (vs. typed manually) */
	let formComposePathBrowsed = $state(false);

	let cloneStatus = $state<'idle' | 'cloning' | 'success' | 'error'>('idle');
	let cloneError = $state<string | null>(null);
	let cloningRepoId = $state<number | null>(null);
	let pollHandle: JobPollingHandle | null = null;

	function stopPolling() {
		pollHandle?.stop();
		pollHandle = null;
	}

	async function deleteRepositoryAndClose() {
		const targetId = cloningRepoId ?? formRepositoryId;
		if (!targetId) return;
		try {
			await fetch(`/api/git/repositories/${targetId}`, { method: 'DELETE' });
			onRepositoryCreated?.(); // Refresh list
		} catch (e) {
			// ignore
		}
		cloneStatus = 'idle';
		stopPolling();
		cloningRepoId = null;
	}

	function startPolling(jobId: string, repoId: number) {
		stopPolling();
		pollHandle = startJobPolling(jobId, {
			onDone: async () => {
				cloneStatus = 'success';
				cloningRepoId = null;
				onRepositoryCreated?.(); // refresh list
				// Switch to 'existing' mode so the stack-save flow uses the real repo ID
				formRepositoryId = repoId;
				formRepoMode = 'existing';
				configureGitBrowser();
				showGitRepoBrowser = true;
				await addDetectedGitComposeOverrides(formComposePaths[0] || formComposePath || 'compose.yaml');
				cloneStatus = 'idle';
			},
			onError: (error) => {
				cloneStatus = 'error';
				// Keep cloningRepoId set so they can delete it
				cloneError = error ?? 'Clone failed — check the repository URL and credentials.';
				onRepositoryCreated?.();
			},
			onUnavailable: () => {
				cloneStatus = 'error';
				cloneError = 'Could not retrieve clone status. The repository may still be cloning in the background.';
			}
		});
	}

	// Track which gitStack was initialized to avoid repeated resets
	let lastInitializedStackId = $state<number | null | undefined>(undefined);
	let isInitializing = $state(false);

	$effect(() => {
		if (open) {
			const currentStackId = gitStack?.id ?? null;
			if (lastInitializedStackId !== currentStackId && !isInitializing) {
				lastInitializedStackId = currentStackId;
				isInitializing = true;
				resetForm().finally(() => {
					isInitializing = false;
				});
			}
		} else {
			lastInitializedStackId = undefined;
		}
	});

	// Derived state for selected repository
	let selectedRepo = $derived(formRepositoryId ? repositories.find(r => r.id === formRepositoryId) : null);

	onMount(() => {
		// F11: sync the client's git mode with the server before showing the modal.
		appSettings.reload();
		// Load saved split ratio
		const savedSplit = localStorage.getItem(STORAGE_KEY_SPLIT);
		if (savedSplit) {
			const ratio = parseFloat(savedSplit);
			if (!isNaN(ratio) && ratio >= 30 && ratio <= 80) {
				splitRatio = ratio;
			}
		}

		// Add global mouse event listeners for split dragging
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);

		fetchSecretProviders();
	});

	async function fetchSecretProviders() {
		try {
			const response = await fetch('/api/secret-providers');
			if (!response.ok) return;
			const data = await response.json();
			secretProviders = (data ?? []).map((p: any) => ({ id: p.id, name: p.name, type: p.type }));
		} catch (e) {
			console.warn('Failed to load secret providers:', e);
		}
	}

	onDestroy(() => {
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
	});

	// Split panel drag handlers
	function startSplitDrag(e: MouseEvent) {
		e.preventDefault();
		isDraggingSplit = true;
	}

	function handleMouseMove(e: MouseEvent) {
		if (isDraggingSplit && containerRef) {
			const rect = containerRef.getBoundingClientRect();
			const newRatio = ((e.clientX - rect.left) / rect.width) * 100;
			splitRatio = Math.max(30, Math.min(80, newRatio));
		}
	}

	function handleMouseUp() {
		if (isDraggingSplit) {
			isDraggingSplit = false;
			// Save split ratio
			localStorage.setItem(STORAGE_KEY_SPLIT, splitRatio.toString());
		}
	}

	async function loadEnvFiles() {
		if (!gitStack) return;

		loadingEnvFiles = true;
		try {
			const response = await fetch(`/api/git/stacks/${gitStack.id}/env-files`);
			if (response.ok) {
				const data = await response.json();
				envFiles = data.files || [];
			}
		} catch (e) {
			console.error('Failed to load env files:', e);
		} finally {
			loadingEnvFiles = false;
		}
	}

	// Read one .env file from the synced clone (repo-root-relative path). Not-found /
	// error yields {} so a missing file is harmless.
	async function readRepoEnvFile(path: string): Promise<Record<string, string>> {
		if (!gitStack || !path) return {};
		try {
			const response = await fetch(`/api/git/stacks/${gitStack.id}/env-files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path })
			});
			if (response.ok) {
				const data = await response.json();
				return data.vars || {};
			}
		} catch (e) {
			console.error('Failed to read env file contents:', e);
		}
		return {};
	}

	// Populate fileEnvVars with what the deploy sees: the compose-dir default .env as
	// the base, then the explicit envFilePath layered on top (deploy applies the custom
	// env file second). This is the diff base for save AND the file base for the merge.
	async function loadEnvFileContents(explicitPath: string | null) {
		if (!gitStack) {
			fileEnvVars = {};
			return;
		}
		loadingFileVars = true;
		try {
			const composeDir = (formComposePath || 'compose.yaml').replace(/[^/]*$/, '');
			const defaultEnvPath = `${composeDir}.env`;
			const base = await readRepoEnvFile(defaultEnvPath);
			const overlay =
				explicitPath && explicitPath !== defaultEnvPath
					? await readRepoEnvFile(explicitPath)
					: {};
			fileEnvVars = { ...base, ...overlay };
		} finally {
			loadingFileVars = false;
		}
	}

	async function loadEnvVarsOverrides() {
		if (!gitStack) return;

		try {
			// Use gitStack.environmentId when editing, fall back to prop for new stacks
			const envIdToUse = gitStack.environmentId ?? environmentId;
			const response = await fetch(`/api/stacks/${encodeURIComponent(gitStack.stackName)}/env${envIdToUse ? `?env=${envIdToUse}` : ''}`);
			if (response.ok) {
				const data = await response.json();
				const loadedVars = data.variables || [];
				// Track existing secret keys (secrets loaded from DB cannot have visibility toggled)
				existingSecretKeys = new Set(
					loadedVars.filter((v: EnvVar) => v.isSecret && v.key.trim()).map((v: EnvVar) => v.key.trim())
				);
				// Set envVars - the panel's $effect will auto-sync rawContent for text view
				envVars = loadedVars;
				injectedSecretKeys = data.injectedSecretKeys ?? [];
			}
		} catch (e) {
			console.error('Failed to load env var overrides:', e);
		}
	}

	function clearPreviewState() {
		previewRequestSeq++;
		envValidationSeq++;
		envValidation = null;
		previewedComposePaths = [];
		previewedComposeContent = '';
		previewedComposeContents = {};
		if (gitStack) {
			populatingEnvVars = false;
			return;
		}
		const previousFileKeys = new Set(Object.keys(fileEnvVars));
		if (previousFileKeys.size > 0) {
			envVars = envVars.filter((variable) => !previousFileKeys.has(variable.key));
		}
		fileEnvVars = {};
		populatingEnvVars = false;
	}

	async function validatePreviewedEnvVars(
		composeContent: string = previewedComposeContent,
		composeContents: Record<string, string> = previewedComposeContents,
		composePaths: string[] = previewedComposePaths,
		variables: EnvVar[] = envVars
	) {
		if (!composeContent.trim()) return;

		const seq = ++envValidationSeq;
		try {
			const stackName = encodeURIComponent(formStackName.trim() || 'new');
			const response = await fetch(appendEnvParam(`/api/stacks/${stackName}/env/validate`, effectiveEnvId), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					compose: composeContent,
					composePaths,
					composeContents,
					variables: variables.filter((v) => v.key.trim()).map((v) => v.key.trim())
				})
			});

			if (seq !== envValidationSeq) return;
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw new Error(data.error || `Validation failed (${response.status})`);
			}

			skipNextEnvValidationEffect = true;
			envValidation = await response.json() as ValidationResult;
		} catch (e) {
			if (seq !== envValidationSeq) return;
			console.error('Failed to validate env vars:', e);
			toast.error('Failed to validate environment variables');
		}
	}

	async function populateEnvVars() {
		// Validate we have repository info
		if (formRepoMode === 'existing' && !formRepositoryId) {
			toast.error('Please select a repository first');
			return;
		}
		if (formRepoMode === 'new' && !formNewRepoUrl.trim()) {
			toast.error('Please enter a repository URL first');
			return;
		}

		clearPreviewState();
		const seq = previewRequestSeq;
		const selectedComposePaths = formComposePaths.map((path) => path.trim()).filter(Boolean);
		const primaryComposePath = selectedComposePaths[0] || formComposePath.trim() || 'compose.yaml';
		const orderedComposePaths = selectedComposePaths.length > 0 ? selectedComposePaths : [primaryComposePath];
		populatingEnvVars = true;
		try {
			const body: Record<string, any> = {
				composePath: primaryComposePath,
				composePaths: orderedComposePaths,
				envFilePath: formEnvFilePath || null
			};

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
				// Send the selected branch so env files are previewed from it (per-stack override)
				body.branch = formBranch || undefined;
			} else {
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
			}

			const response = await fetch(gitStack ? `/api/git/stacks/${gitStack.id}/env-files` : '/api/git/preview-env', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(gitStack ? { populate: true } : body)
			});

			const data = await response.json();
			if (seq !== previewRequestSeq) return;

			if (!response.ok) {
				toast.error('Failed to load env variables', {
					description: data.error || 'Unknown error'
				});
				return;
			}

			const vars = (data.vars || {}) as Record<string, string>;
			const composeContent = typeof data.composeContent === 'string' ? data.composeContent : '';
			const composeContents = data.composeContents && typeof data.composeContents === 'object' && !Array.isArray(data.composeContents)
				? data.composeContents as Record<string, string>
				: {};
			const previewComposePaths = Object.keys(composeContents).length > 0 ? Object.keys(composeContents) : orderedComposePaths;
			previewedComposePaths = previewComposePaths;
			previewedComposeContent = composeContent;
			previewedComposeContents = composeContents;

			// Refresh the file base from the repo, then merge the current editor state on
			// top so re-populating never clobbers the user's values. Any editor value that
			// differs from the fresh repo (a real edit, or a secret) wins; keys the user
			// never touched follow the refreshed repo value.
			const nextEnvVars = mergeGitStackEnvVars(vars, envVars.filter((v) => v.key.trim()));
			fileEnvVars = vars;
			envVars = nextEnvVars;

			if (Object.keys(vars).length === 0) {
				toast.info('No environment variables found', {
					description: 'No .env files found in the repository. Required compose variables will still be shown as missing.'
				});
			}

			await validatePreviewedEnvVars(composeContent, composeContents, previewComposePaths, nextEnvVars);
		} catch (e) {
			if (seq !== previewRequestSeq) return;
			console.error('Failed to populate env vars:', e);
			toast.error('Failed to load env variables');
		} finally {
			if (seq === previewRequestSeq) populatingEnvVars = false;
		}
	}

	// Revalidate after environment-variable edits, but not on every keystroke.
	$effect(() => {
		const variables = envVars;
		if (!open || !envValidation || !previewedComposeContent.trim()) return;
		if (skipNextEnvValidationEffect) {
			skipNextEnvValidationEffect = false;
			return;
		}

		const timeout = setTimeout(() => {
			void validatePreviewedEnvVars(previewedComposeContent, previewedComposeContents, previewedComposePaths, variables);
		}, 800);
		return () => clearTimeout(timeout);
	});

	async function resetForm() {
		hostCopyPaths = [];
		// Clear state BEFORE async loads to avoid race conditions
		activeTab = 'settings';
		draftEditorReady = false;
		draftHasLinkableFile = false;
		draftEditorDirty = false;
		draftComposeContents = {};
		draftOriginalComposeContents = {};
		draftComposeRevisions = {};
		draftComposeClassifications = [];
		draftLinkedEntries = [];
		draftFolders = [];
		draftLoadSeq++;
		// Reset the deploy-output overlay so a previous run's window (bound to
		// outputOpen) can't reappear over a freshly opened modal -- the main modal is
		// deliberately left open behind it after a deploy, so closing the main modal
		// first would otherwise leave outputOpen=true with stale lines.
		outputOpen = false;
		outputLines = [];
		outputRunning = false;
		outputOk = undefined;
		outputMs = undefined;
		outputExitCode = undefined;
		stackVolumes = [];
		stackVolumesLoaded = false;
		backupTally = { ok: 0, failed: 0 };
		backupTallyLoaded = false;
		formError = '';
		errors = {};
		envFiles = [];
		envVars = [];
		fileEnvVars = {};
		envValidation = null;
		previewedComposePaths = [];
		previewedComposeContent = '';
		previewedComposeContents = {};
		previewRequestSeq++;
		envValidationSeq++;
		skipNextEnvValidationEffect = false;
		existingSecretKeys = new Set();
		temporaryCloneToken = null;
		temporaryCloneRepositoryId = null;
		temporaryCloneBranch = null;

		if (gitStack) {
			formRepoMode = 'existing';
			formRepositoryId = gitStack.repositoryId;
			formStackName = gitStack.stackName;
			if ($page.data.backupsEnabled) void loadBackupTally();
			formComposePath = gitStack.composePath;
			try {
				formComposePaths = gitStack.composePaths ? JSON.parse(gitStack.composePaths) : [];
				if (formComposePaths.length === 0) formComposePaths = [gitStack.composePath || 'compose.yaml'];
			} catch { formComposePaths = [gitStack.composePath || 'compose.yaml']; }
			formEnvFilePath = gitStack.envFilePath;
			formContextDir = gitStack.contextDir ?? null;
			formBuildOnDeploy = gitStack.buildOnDeploy ?? false;
			formNoBuildCache = gitStack.noBuildCache ?? false;
			formRepullImages = gitStack.repullImages ?? false;
			formForceRedeploy = gitStack.forceRedeploy ?? false;
			formStackWebhookEnabled = gitStack.webhookEnabled ?? false;
			formStackWebhookSecret = gitStack.webhookSecret || '';
			formStackAutoUpdate = gitStack.autoUpdate ?? false;
			formStackAutoUpdateSchedule = (gitStack.autoUpdateSchedule as 'daily' | 'weekly' | 'custom') ?? 'daily';
			formStackAutoUpdateCron = gitStack.autoUpdateCron || '0 3 * * *';
			formDeployNow = false;
			formSecretProviderId = null;

			// Load secret provider binding
			loadSecretProviderBindingForStack(gitStack.stackName);
			// Per-stack branch override; null means "use the repository default"
			formBranch = gitStack.branch ?? null;

			// Load env files and overrides SYNCHRONOUSLY to avoid race conditions
			// Wait for all loads to complete before allowing any other effect to run.
			// Always read the repo .env (default compose-dir .env + explicit envFilePath)
			// so the editor can show the full effective set, not just DB overrides.
			await Promise.all([
				loadEnvFiles(),
				loadEnvVarsOverrides(),
				loadEnvFileContents(gitStack.envFilePath)
			]);

			// Merge repo .env (base) with DB overrides/secrets so untouched populated
			// vars stay visible on reopen. The save filter still drops file-equal
			// non-secrets, keeping the DB override-only (git-sync pickup intact).
			envVars = mergeGitStackEnvVars(fileEnvVars, envVars);
		} else if (adoptionTarget) {
			formRepoMode = repositories.length > 0 ? 'existing' : 'new';
			formRepositoryId = null;
			formNewRepoName = '';
			formNewRepoUrl = '';
			formNewRepoBranch = 'main';
			formNewRepoCredentialId = null;
			formNewRepoAutoUpdate = false;
			formNewRepoAutoUpdateCron = '0 3 * * *';
			formNewRepoWebhookEnabled = false;
			formNewRepoWebhookSecret = '';
			formStackName = adoptionTarget.stackName;
			formStackNameUserModified = true;
			formComposePath = 'compose.yaml';
			formComposePaths = ['compose.yaml'];
			formComposePathBrowsed = false;
			formEnvFilePath = null;
			formContextDir = null;
			formBuildOnDeploy = false;
			formNoBuildCache = false;
			formRepullImages = false;
			formForceRedeploy = false;
			formStackWebhookEnabled = false;
			formStackWebhookSecret = '';
			formStackAutoUpdate = false;
			formStackAutoUpdateSchedule = 'daily';
			formStackAutoUpdateCron = '0 3 * * *';
			formDeployNow = true;
			formSecretProviderId = null;
		} else {
			formRepoMode = repositories.length > 0 ? 'existing' : 'new';
			formRepositoryId = null;
			formNewRepoName = '';
			formNewRepoUrl = '';
			formNewRepoBranch = 'main';
			formNewRepoCredentialId = null;
			formNewRepoAutoUpdate = false;
			formNewRepoAutoUpdateCron = '0 3 * * *';
			formNewRepoWebhookEnabled = false;
			formNewRepoWebhookSecret = '';
			formStackName = '';
			formStackNameUserModified = false;
			formComposePath = 'compose.yaml';
			formComposePaths = ['compose.yaml'];
			formComposePathBrowsed = false;
			formEnvFilePath = null;
			formContextDir = null;
			formBuildOnDeploy = false;
			formNoBuildCache = false;
			formRepullImages = false;
			formForceRedeploy = false;
			formStackWebhookEnabled = false;
			formStackWebhookSecret = '';
			formStackAutoUpdate = false;
			formStackAutoUpdateSchedule = 'daily';
			formStackAutoUpdateCron = '0 3 * * *';
			formDeployNow = false;
			formSecretProviderId = null;
		}
	}

	async function loadSecretProviderBindingForStack(stackName: string) {
		try {
			const url = effectiveEnvId ? `/api/stacks/sources?env=${effectiveEnvId}` : '/api/stacks/sources';
			const response = await fetch(url);
			if (!response.ok) return;
			const sourceMap = await response.json();
			const source = sourceMap?.[stackName];
			formSecretProviderId = source?.secretProviderId ?? null;
		} catch (e) {
			console.warn('Failed to load secret provider binding for git stack:', e);
		}
	}

	async function fetchBranches() {
		const seq = ++branchesFetchSeq;
		branchesLoading = true;
		branches = [];
		try {
			const body: Record<string, any> = {};
			if (formRepoMode === 'existing' && formRepositoryId) {
				body.repositoryId = formRepositoryId;
			} else if (formRepoMode === 'new' && formNewRepoUrl) {
				body.url = formNewRepoUrl;
				body.credentialId = formNewRepoCredentialId;
			} else {
				return;
			}
			const response = await fetch('/api/git/branches', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			// A newer fetch (or a repo change) superseded this one — drop the
			// stale response so it cannot overwrite the new repo's branch list.
			if (seq !== branchesFetchSeq) return;
			if (response.ok) {
				const data = await response.json();
				if (seq !== branchesFetchSeq) return;
				branches = data.branches || [];
			}
		} catch (e) {
			if (seq !== branchesFetchSeq) return;
			console.error('Failed to fetch branches:', e);
		} finally {
			if (seq === branchesFetchSeq) branchesLoading = false;
		}
	}

	async function saveGitStack(deployAfterSave: boolean = false) {
		const deploying = deployAfterSave || isAdopting;
		errors = {};
		let hasErrors = false;

		const trimmedStackName = formStackName.trim();
		if (!trimmedStackName) {
			errors.stackName = 'Stack name is required';
			hasErrors = true;
		} else if (!STACK_NAME_REGEX.test(trimmedStackName)) {
			errors.stackName = 'Stack name must be lowercase, start with a letter or number, and contain only letters, numbers, hyphens, and underscores';
			hasErrors = true;
		}

		if (formRepoMode === 'existing' && !formRepositoryId) {
			errors.repository = 'Please select a repository';
			hasErrors = true;
		}

		if (formRepoMode === 'new' && !formNewRepoName.trim()) {
			errors.repoName = 'Repository name is required';
			hasErrors = true;
		}

		if (formRepoMode === 'new' && !formNewRepoUrl.trim()) {
			errors.repoUrl = 'Repository URL is required';
			hasErrors = true;
		}

		const newRepoWebhookSecretError = formRepoMode === 'new'
			? ($page.data.allowSecretlessWebhook && formNewRepoWebhookEnabled && !formNewRepoWebhookSecret.trim()
				? undefined
				: webhookSecretValidationError(formNewRepoWebhookEnabled, formNewRepoWebhookSecret))
			: undefined;
		if (newRepoWebhookSecretError) {
			errors.newRepoWebhookSecret = newRepoWebhookSecretError;
			hasErrors = true;
		}

		const stackWebhookSecretError = isCentralizedMode
			? (formForceRedeploy
				? ($page.data.allowSecretlessWebhook && formStackWebhookEnabled && !formStackWebhookSecret.trim()
					? undefined
					: webhookSecretValidationError(formStackWebhookEnabled, formStackWebhookSecret))
				: undefined)
			: ($page.data.allowSecretlessWebhook && formStackWebhookEnabled && !formStackWebhookSecret.trim()
				? undefined
				: webhookSecretValidationError(formStackWebhookEnabled, formStackWebhookSecret));
		if (stackWebhookSecretError) {
			errors.stackWebhookSecret = stackWebhookSecretError;
			hasErrors = true;
		}

		if (hasErrors) return;

		// Adoption has already selected the authoritative external row; ordinary
		// creation keeps the client-side warning as a convenience only.
		if (!gitStack && !isAdopting) {
			try {
				const stacksResponse = await fetch(`/api/stacks?env=${environmentId}`);
				if (stacksResponse.ok) {
					const stacks = await stacksResponse.json();
					const existingStack = stacks.find((s: { name: string }) =>
						s.name.toLowerCase() === formStackName.trim().toLowerCase()
					);
					if (existingStack) {
						showExistsWarning = true;
						return;
					}
				}
			} catch (e) {
				console.warn('Failed to check for existing stacks:', e);
			}
		}

		formSaving = true;
		formError = '';

		try {
			// Store only actual overrides (differ from file / new / secret) so file updates
			// from git are picked up on next sync. Shared predicate keeps this in step with
			// the merge round-trip guard and the re-populate preserve step.
			const overrideVars = envVars.filter((v) => isGitStackOverride(v, fileEnvVars));

			let body: any = {
				stackName: formStackName,
				composePath: formComposePath || 'compose.yaml',
				composePaths: formComposePaths.length > 0 ? formComposePaths : null,
				envFilePath: formEnvFilePath,
				environmentId: effectiveEnvId,
				contextDir: formContextDir || null,
				buildOnDeploy: formBuildOnDeploy,
				noBuildCache: formNoBuildCache,
				repullImages: formRepullImages,
				forceRedeploy: formForceRedeploy,
				deployNow: isAdopting ? true : deployAfterSave,
				adoptExternal: isAdopting,
				...(isAdopting ? { copyPaths: hostCopyPaths } : {}),
				secretProviderId: formSecretProviderId,
				envVars: overrideVars.map(v => ({
					key: v.key.trim(),
					value: v.value,
					isSecret: v.isSecret
				}))
			};
			if (temporaryCloneToken && !gitStack) body.temporaryCloneToken = temporaryCloneToken;
			if (!gitStack && draftEditorReady && draftEditorDirty) {
				body.composeContents = draftComposeContents;
				body.linkedFiles = draftLinkedEntries.map(({ path, ownership, postChange }) => ({ path, ownership, postChange }));
				body.linkedFileContents = Object.fromEntries(draftLinkedEntries.map((entry) => [entry.path, entry.content]));
				body.createdFolders = draftFolders;
				body.editorRevisions = draftComposeRevisions;
				body.editorClassifications = [...draftComposeClassifications, ...draftLinkedEntries.map((entry) => ({ path: entry.path, tracked: entry.tracked === true, ignored: entry.ignored === true }))];
				const commitChanges = window.confirm('Commit and push tracked configuration changes? Cancel keeps them local for this deployment.');
				body.trackedDecision = commitChanges ? 'commit' : 'internal';
				const addChanges = window.confirm('Add untracked configuration changes to Git? Cancel keeps them local.');
				body.untrackedDecision = addChanges ? 'add' : 'local';
				if (commitChanges || addChanges) {
					body.commitMessage = window.prompt('Git commit message', `Update ${formStackName} configuration`) || undefined;
				}
			}

			if (isCentralizedMode) {
				// Centralized: stack webhook only under force redeploy; schedules live on the repository.
				body.webhookEnabled = formForceRedeploy ? formStackWebhookEnabled : false;
				body.webhookSecret = (formForceRedeploy && formStackWebhookEnabled) ? formStackWebhookSecret || null : null;
			} else {
				// Stack mode: stack-level scheduled sync + webhook (not gated by force redeploy).
				body.webhookEnabled = formStackWebhookEnabled;
				body.webhookSecret = formStackWebhookEnabled ? formStackWebhookSecret || null : null;
				body.autoUpdate = formStackAutoUpdate;
				body.autoUpdateSchedule = formStackAutoUpdate ? formStackAutoUpdateSchedule : undefined;
				body.autoUpdateCron = formStackAutoUpdate ? (formStackAutoUpdateSchedule === 'custom' ? formStackAutoUpdateCron : undefined) : undefined;
			}

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
				// Per-stack branch override — sent on both create and update so the
				// stack payload is the single source of truth (null = inherit repo default)
				body.branch = formBranch || null;
			} else {
				// Create new repo inline
				body.repoName = formNewRepoName;
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
				if (isCentralizedMode) {
					body.autoUpdate = formNewRepoAutoUpdate;
					body.autoUpdateCron = formNewRepoAutoUpdateCron;
					body.webhookEnabled = formNewRepoWebhookEnabled;
					body.webhookSecret = formNewRepoWebhookEnabled ? formNewRepoWebhookSecret : null;
				}
			}

			const url = gitStack
				? `/api/git/stacks/${gitStack.id}`
				: '/api/git/stacks';
			const method = gitStack ? 'PUT' : 'POST';

			// Live-stream the compose output into the shared window when deploying, so
			// "Save and deploy" shows progress like StackModal's "Save & redeploy".
			// (A plain save with no deploy has no output to show.)
			if (deploying) {
				outputTitle = `Deploying ${formStackName.trim()}`;
				outputLines = [];
				outputRunning = true;
				outputOk = undefined;
				outputMs = undefined;
				outputExitCode = undefined;
				outputStartedAt = Date.now();
				outputOpen = true;
			}

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = deploying
				? await readJobResponse(response, (line) => (outputLines = [...outputLines, line]))
				: await readJobResponse(response);

			if (!response.ok) {
				if (deploying) {
					// A pre-deploy failure (e.g. git sync) streams no lines, so surface
					// the error text in the window instead of "No logs available".
					if (outputLines.length === 0 && data.error) outputLines = String(data.error).split('\n');
					outputRunning = false;
					outputOk = false;
					outputMs = Date.now() - outputStartedAt;
				}
				formError = data.error || 'Failed to save git stack';
				return;
			}

			// Check if deployment failed
			const deployResult = data.deployResult as { success?: boolean; error?: string } | undefined;
			if (deploying) {
				const ok = !(deployResult && !deployResult.success);
				// The sync phase (clone/pull) fails before any compose line streams, so
				// on a failure with no streamed output, show the error text.
				if (!ok && outputLines.length === 0 && deployResult?.error) {
					outputLines = String(deployResult.error).split('\n');
				}
				outputRunning = false;
				outputOk = ok;
				outputMs = Date.now() - outputStartedAt;
			}
			if (deployResult && !deployResult.success) {
				toast.error('Deployment failed', {
					description: deployResult.error || 'Unknown error'
				});
				deploysReloadKey++; // the failed run is recorded; refresh the Deploys tab
				onSaved(); // Still refresh the list to show the new stack
				// Keep the modal open so the user can read the output window; they close it.
				return;
			}

			deploysReloadKey++; // a new run was recorded; refresh the Deploys tab
			onSaved();
			switch (saveCloseTiming(deploying, true)) {
				case 'close':
					onClose();
					break;
				case 'close-delayed':
					setTimeout(() => {
						outputOpen = false;
						onClose();
					}, DEPLOY_SUCCESS_CLOSE_DELAY_MS);
					break;
				case 'stay-open':
					break;
			}
		} catch (error) {
			formError = 'Failed to save git stack';
		} finally {
			formSaving = false;
		}
	}

	// Fetch branches when repository selection changes
	$effect(() => {
		if (formRepoMode === 'existing' && formRepositoryId) {
			void fetchBranches();
			// A fresh stack inherits the repository's default until a branch is
			// picked. When editing, the stored per-stack override (set in
			// resetForm) must be preserved — null means repository default.
			if (!gitStack) formBranch = null;
		} else if (formRepoMode === 'new' && formNewRepoUrl) {
			void fetchBranches();
		} else {
			branches = [];
		}
	});

	// Auto-populate stack name from selected repo and compose path (only if user hasn't manually edited)
	// Auto-populate stack name from selected repo and compose path (only if user hasn't manually edited
	// AND the path wasn't set via the Browse button — Browse already sets the optimal name from parent dir).
	$effect(() => {
		if (formRepoMode === 'existing' && formRepositoryId && !gitStack && !isAdopting && !formStackNameUserModified && !formComposePathBrowsed) {
			const repo = repositories.find(r => r.id === formRepositoryId);
			if (repo) {
				// Normalize repo name: lowercase, spaces/underscores to hyphens, strip invalid chars
				const normalizedName = repo.name
					.toLowerCase()
					.replace(/[\s_]+/g, '-')
					.replace(/[^a-z0-9-]/g, '')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '');

				// Extract compose filename without extension for stack name
				const composeName = formComposePath
					.replace(/^.*\//, '') // Remove directory path
					.replace(/\.(yml|yaml)$/i, '') // Remove extension
					.replace(/^docker-compose\.?/, '') // Remove docker-compose prefix
					.replace(/^compose$/, ''); // Remove plain "compose"

				// Combine repo name with compose name if it's not the default
				if (composeName && composeName !== 'docker-compose') {
					formStackName = `${normalizedName}-${composeName}`;
				} else {
					formStackName = normalizedName;
				}
			}
		}
	});

	async function openGitRepoBrowser() {
		gitBrowserError = null;
		gitBrowserPurpose = 'compose';
		gitBrowserInitialPath = '';

		if (formRepoMode === 'new') {
			// Validate required fields before creating the repo
			const newErrors: typeof errors = {};
			if (!formNewRepoName.trim()) newErrors.repoName = 'Required before browsing';
			if (!formNewRepoUrl.trim()) newErrors.repoUrl = 'Required before browsing';
			if (newErrors.repoName || newErrors.repoUrl) {
				errors = { ...errors, ...newErrors };
				return;
			}

			try {
				// Check if a repo with this URL+branch already exists to avoid creating duplicates
				const existingRes = await fetch('/api/git/repositories');
				const allRepos: GitRepository[] = existingRes.ok ? await existingRes.json() : [];
				const existingRepo = allRepos.find(
					r => r.url === formNewRepoUrl.trim() && r.branch === (formNewRepoBranch || 'main')
				);

				let repoId: number;
				let cloneJobId: string | undefined;
				if (existingRepo) {
					// Reuse the existing repository — no duplicate created
					repoId = existingRepo.id;
					formNewRepoName = existingRepo.name;
				} else {
					// Create metadata only. Per-stack repositories are cloned into a
					// temporary checkout below and adopted on first deployment.
					const res = await fetch('/api/git/repositories', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							...(isCentralizedMode ? { 'X-Dockhand-Async': '1' } : {})
						},
						body: JSON.stringify({
							name: formNewRepoName.trim(),
							url: formNewRepoUrl.trim(),
							branch: formNewRepoBranch || 'main',
							credentialId: formNewRepoCredentialId
						})
					});
					const data = await res.json();
					if (!res.ok) {
						gitBrowserError = data.error || 'Failed to save repository';
						toast.error('Failed to save repository', { description: gitBrowserError || undefined });
						return;
					}
					repoId = data.id;
					cloneJobId = data.jobId;
				}

				formRepositoryId = repoId;
				formRepoMode = 'existing';
				if (isCentralizedMode && cloneJobId) {
					cloneStatus = 'cloning';
					cloneError = null;
					cloningRepoId = repoId;
					startPolling(cloneJobId, repoId);
					return;
				}
				if (!gitStack && !isCentralizedMode) {
					if (!(await prepareTemporaryClone(repoId, formNewRepoBranch || 'main'))) return;
				}
				configureGitBrowser();
				showGitRepoBrowser = true;
				await addDetectedGitComposeOverrides(formComposePaths[0] || formComposePath || 'compose.yaml');
			} catch (e) {
				gitBrowserError = 'Failed to save repository';
				toast.error('Failed to save repository');
			}
		} else {
			if (!formRepositoryId) return;
			if (!gitStack && !isCentralizedMode) {
				if (!(await prepareTemporaryClone(formRepositoryId, formBranch || selectedRepo?.branch))) return;
			}
			configureGitBrowser();
			showGitRepoBrowser = true;
			await addDetectedGitComposeOverrides(formComposePaths[0] || formComposePath || 'compose.yaml');
		}
	}

	async function handleGitMultiBrowseSelect(entries: { path: string; name: string }[]) {
		clearPreviewState();
		const newRelativePaths: string[] = [];
		for (const entry of entries) {
			const relativePath = gitBrowserRootPath && entry.path.startsWith(gitBrowserRootPath)
				? entry.path.slice(gitBrowserRootPath.length).replace(/^\//, '')
				: entry.path;
			if (!formComposePaths.includes(relativePath)) {
				formComposePaths = [...formComposePaths, relativePath];
				newRelativePaths.push(relativePath);
			}
		}
		// Set first selected as primary and auto-derive stack name from parent dir
		if (newRelativePaths.length > 0) {
			if (!formComposePath) formComposePath = newRelativePaths[0];
			if (!formStackNameUserModified) {
				const parts = newRelativePaths[0].split('/');
				if (parts.length >= 2) {
					const parentDir = parts[parts.length - 2];
					formStackName = parentDir
						.toLowerCase()
						.replace(/[\s_]+/g, '-')
						.replace(/[^a-z0-9-]/g, '')
						.replace(/-+/g, '-')
						.replace(/^-|-$/g, '');
					formComposePathBrowsed = true;
				}
			}
		}
		showGitRepoBrowser = false;
		if (!gitStack) await loadGitDraftEditor();
	}

</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); }}>
	<Dialog.Content
		class="max-w-none w-[calc(100vw-4rem)] h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700 max-md:w-[calc(100vw-1rem)]! max-md:h-[calc(100dvh-1rem)]! max-md:max-w-none! max-md:max-h-[calc(100dvh-1rem)]! max-md:rounded-2xl! max-md:border! max-md:border-border!"
		showCloseButton={false}
	>
		<Dialog.Header class="px-4 py-3 text-left sm:px-5 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					{#if gitStack}
						<button
							type="button"
							aria-label="Change stack icon"
							title="Change stack icon"
							onclick={() => (showIconPicker = true)}
							class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700 hover:ring-2 hover:ring-primary transition-shadow"
						>
							{#if formIcon}
								<StackIcon icon={formIcon} stackName={gitStack.stackName} envId={effectiveEnvId} class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
							{:else}
								<GitBranch class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
							{/if}
						</button>
					{:else}
						<div class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
							<GitBranch class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
						</div>
					{/if}
					<div>
						<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							{isAdopting ? 'Convert to Git' : gitStack ? 'Edit git stack' : 'Deploy from Git'}
						</Dialog.Title>
						<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">
							{isAdopting ? 'Reuse the running Compose project without moving its original files' : gitStack ? 'Update git stack settings' : 'Deploy a compose stack from a Git repository'}
						</Dialog.Description>
						<div class="flex items-center gap-2 mt-1">
							<Badge variant="outline" class="text-2xs py-0 px-1.5">
								{gitStack
									? (gitStack.engine === 'centralized' ? 'Centralized (shared clone)' : 'Per-stack clone')
									: (isCentralizedMode ? 'Centralized (shared clone)' : 'Per-stack clone')}
							</Badge>
							{#if gitStack && gitStack.engine === 'stack'}
								<Button size="sm" variant="outline" class="h-5 px-2 text-2xs" onclick={migrateStack} disabled={migrating}>
									{#if migrating}<Loader2 class="w-3 h-3 animate-spin" />{/if}
									Migrate to centralized
								</Button>
							{/if}
						</div>
					</div>
				</div>

				<!-- Close button -->
				<button
					type="button"
					aria-label="Close stack editor"
					onclick={onClose}
					class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
		</Dialog.Header>

		<!-- Stack views. A new Git stack gains Editor only after its first Compose load. -->
		{#if gitStack || draftEditorReady}
			<div class="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 px-5 dark:border-zinc-700 flex-shrink-0">
				{#if gitStack}
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 px-3 max-md:px-2 py-2 text-sm transition-colors {activeTab === 'settings' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = 'settings')}
				>
					<Settings2 class="h-3.5 w-3.5" /> Settings
				</button>
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 border-transparent px-3 max-md:px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
					onclick={() => openStackView('editor')}
				>
					<Code class="h-3.5 w-3.5" /> Editor
				</button>
				{:else}
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 px-3 max-md:px-2 py-2 text-sm transition-colors {activeTab === 'settings' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = 'settings')}
				>
					<Settings2 class="h-3.5 w-3.5" /> Settings
				</button>
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 px-3 max-md:px-2 py-2 text-sm transition-colors {activeTab === 'editor' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = 'editor')}
				>
					<Code class="h-3.5 w-3.5" /> Editor
				</button>
				{/if}
				{#if gitStack}
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 border-transparent px-3 max-md:px-2 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
					onclick={() => openStackView('graph')}
				>
					<GitGraph class="h-3.5 w-3.5" /> Graph
				</button>
				<button
					type="button"
					class="relative -mb-px flex max-md:flex-1 items-center max-md:justify-center gap-1.5 border-b-2 px-3 max-md:px-2 py-2 text-sm transition-colors {activeTab === 'deploys' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeTab = 'deploys')}
				>
					<History class="h-3.5 w-3.5" /> Deploys
					{#if deploysTally.ok > 0}
						<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-500"><Check class="h-2.5 w-2.5" />{deploysTally.ok}</span>
					{/if}
					{#if deploysTally.failed > 0}
						<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500"><X class="h-2.5 w-2.5" />{deploysTally.failed}</span>
					{/if}
					{#if deploysTally.total > 0 && deploysTally.ok === 0 && deploysTally.failed === 0}
						<Badge variant="secondary" class="ml-0.5 h-4 min-w-4 justify-center rounded-full px-1 text-[10px] tabular-nums">{deploysTally.total}</Badge>
					{/if}
				</button>
				{#if $page.data.backupsEnabled}
					<button
						type="button"
						class="relative -mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors {activeTab === 'backups' ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}"
						onclick={() => (activeTab = 'backups')}
					>
						<Archive class="h-3.5 w-3.5" /> Backups
						{#if backupTally.ok > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 px-1.5 text-[10px] font-medium text-emerald-500"><Check class="w-2.5 h-2.5" />{backupTally.ok}</span>{/if}
						{#if backupTally.failed > 0}<span class="inline-flex items-center gap-0.5 rounded-full bg-red-500/15 px-1.5 text-[10px] font-semibold text-red-500"><X class="w-2.5 h-2.5" />{backupTally.failed}</span>{/if}
					</button>
				{/if}
				{/if}
			</div>
		{/if}

		{#if activeTab === 'backups' && gitStack && $page.data.backupsEnabled}
			<div class="min-h-0 flex-1 overflow-auto p-5">
				<BackupPanel
					containerName={formStackName}
					volumes={stackVolumes}
					type="stack"
					environmentId={effectiveEnvId ?? undefined}
					onTally={(t) => (backupTally = t)}
				/>
			</div>
		{:else if activeTab === 'deploys' && gitStack}
			<div class="flex min-h-0 flex-1 flex-col p-5">
				<DeploysPanel stackName={gitStack.stackName} envId={effectiveEnvId} reloadKey={deploysReloadKey} onTally={(t) => (deploysTally = t)} />
			</div>
		{:else if activeTab === 'editor' && !gitStack && draftEditorReady}
			<div bind:this={containerRef} class="flex min-h-0 flex-1 flex-col {isDraggingSplit ? 'select-none' : ''}">
				<div class="flex items-center gap-1 border-b border-zinc-200 px-4 dark:border-zinc-700 md:hidden">
					<button type="button" class="flex-1 py-2 text-sm {mobilePane === 'form' ? 'border-b-2 border-primary' : ''}" onclick={() => mobilePane = 'form'}><Code class="mr-1 inline h-3.5 w-3.5" />Compose</button>
					<button type="button" class="flex-1 py-2 text-sm {mobilePane === 'vars' ? 'border-b-2 border-primary' : ''}" onclick={() => mobilePane = 'vars'}><FileText class="mr-1 inline h-3.5 w-3.5" />Variables</button>
				</div>
				<div class="flex min-h-0 flex-1 max-md:flex-col">
					<div class="flex min-h-0 min-w-0 flex-shrink-0 flex-col max-md:w-full! {mobilePane === 'form' ? 'max-md:flex-1' : 'max-md:hidden'}" style="width: {splitRatio}%">
						<StackFileEditor
							bind:this={draftEditorRef}
							composePaths={formComposePaths}
							composeContents={draftComposeContents}
							linkedEntries={draftLinkedEntries}
							createdFolders={draftFolders}
							folderWarning="Empty folders are local only because Git does not track directories."
							{variableMarkers}
							onChange={applyGitDraftEditor}
							onRequestLink={requestGitDraftLink}
							canLink={draftHasLinkableFile || draftLinkedEntries.some((entry) => entry.path.split('/').pop()?.toLocaleLowerCase() !== '.env')}
						/>
					</div>
					<button type="button" class="w-1 flex-shrink-0 cursor-col-resize bg-zinc-200 transition-colors hover:bg-blue-400 dark:bg-zinc-700 dark:hover:bg-blue-500 max-md:hidden" aria-label="Resize compose and variables panels" onmousedown={startSplitDrag}></button>
					<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden {mobilePane === 'vars' ? 'max-md:flex-1' : 'max-md:hidden'}">
						<SecretProviderPicker bind:secretProviderId={formSecretProviderId} bind:envVars providers={secretProviders} />
						<div class="flex min-h-0 flex-1 flex-col px-4 py-4 sm:px-6">
							<StackEnvVarsPanel
								bind:variables={envVars}
								validation={envValidation}
								{existingSecretKeys}
								{injectedSecretKeys}
								hideHeader
								infoText={populatingEnvVars ? 'Loading variables from the repository...' : 'Repository values are defaults. Changed, new, and secret values are saved as Dockhand overrides.'}
								class="min-h-0 flex-1"
							/>
						</div>
					</div>
				</div>
			</div>
		{:else}

		<div bind:this={containerRef} class="flex-1 min-h-0 flex max-md:flex-col {isDraggingSplit ? 'select-none' : ''}">
			<!-- Left column: Form fields -->
			<div class="flex min-w-0 flex-1 flex-col overflow-y-auto">
				<div class="space-y-4 py-4 px-4 sm:px-6">
			<!-- Repository selection -->
			{#if !gitStack}
				<div class="space-y-3">
					<Label>Repository</Label>
					<div class="flex gap-2">
						<Button
							variant={formRepoMode === 'existing' ? 'default' : 'outline'}
							size="sm"
							onclick={() => { clearPreviewState(); formRepoMode = 'existing'; }}
							disabled={repositories.length === 0}
						>
							Select existing
						</Button>
						<Button
							variant={formRepoMode === 'new' ? 'default' : 'outline'}
							size="sm"
							onclick={() => { clearPreviewState(); formRepoMode = 'new'; }}
						>
							Add new
						</Button>
					</div>

					{#if formRepoMode === 'existing'}
						<Select.Root
							type="single"
							value={formRepositoryId?.toString() ?? ''}
							onValueChange={(v) => { clearPreviewState(); formRepositoryId = v ? parseInt(v) : null; errors.repository = undefined; }}
						>
							<Select.Trigger class="w-full {errors.repository ? 'border-destructive' : ''}">
								{#if selectedRepo}
									{@const repoPath = selectedRepo.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')}
									<div class="flex items-center gap-2 text-left">
										{#if selectedRepo.url.includes('github.com')}
											<Github class="w-4 h-4 shrink-0 text-muted-foreground" />
										{:else}
											<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
										{/if}
										<span class="truncate">{selectedRepo.name}</span>
										<span class="text-muted-foreground text-xs truncate hidden sm:inline">({repoPath})</span>
									</div>
								{:else}
									<span class="text-muted-foreground">Select a repository...</span>
								{/if}
							</Select.Trigger>
							<Select.Content>
								{#each repositories as repo}
									{@const repoPath = repo.url.replace(/^https?:\/\/[^/]+\//, '').replace(/\.git$/, '')}
									<Select.Item value={repo.id.toString()} label={repo.name}>
										<div class="flex items-center gap-2">
											{#if repo.url.includes('github.com')}
												<Github class="w-4 h-4 shrink-0 text-muted-foreground" />
											{:else}
												<FolderGit2 class="w-4 h-4 shrink-0 text-muted-foreground" />
											{/if}
											<span>{repo.name}</span>
											<span class="text-muted-foreground text-xs">- {repoPath}</span>
											<span class="text-muted-foreground text-xs flex items-center gap-1">
												<GitBranch class="w-3 h-3" />
												{repo.branch}
											</span>
										</div>
									</Select.Item>
								{/each}
							</Select.Content>
						</Select.Root>
						{#if errors.repository}
							<p class="text-xs text-destructive">{errors.repository}</p>
						{:else if repositories.length === 0}
							<p class="text-xs text-muted-foreground">
								No repositories configured. Click "Add new" to add one.
							</p>
						{/if}
						<!-- Branch selection for existing repository -->
						{#if formRepoMode === 'existing' && selectedRepo}
							<div class="space-y-2">
								<Label for="existing-repo-branch">Branch</Label>
								<BranchCombobox
									id="existing-repo-branch"
									class="max-md:min-h-11"
									value={formBranch ?? ''}
									branches={branches}
									defaultBranch={selectedRepo.branch}
									loading={branchesLoading}
									placeholder="Repository default ({selectedRepo.branch})"
									clearLabel="Repository default ({selectedRepo.branch})"
									onchange={(v) => { clearPreviewState(); formBranch = v; }}
									onclear={() => { clearPreviewState(); formBranch = null; }}
								/>
								<p class="text-xs text-muted-foreground">Branch this stack deploys from. Leave empty to follow the branch configured on the repository ({selectedRepo.branch}).</p>
							</div>
						{/if}
					{:else}
						<div class="space-y-3 p-3 border rounded-md bg-muted/30">
							<div class="space-y-2">
								<Label for="new-repo-name">Repository name</Label>
								<Input
									id="new-repo-name"
									bind:value={formNewRepoName}
									placeholder="e.g., my-stacks"
									class={errors.repoName ? 'border-destructive focus-visible:ring-destructive' : ''}
									oninput={() => errors.repoName = undefined}
								/>
								{#if errors.repoName}
									<p class="text-xs text-destructive">{errors.repoName}</p>
								{/if}
							</div>
							<div class="space-y-2">
								<Label for="new-repo-url">Repository URL</Label>
								<Input
									id="new-repo-url"
									bind:value={formNewRepoUrl}
									placeholder="https://github.com/user/repo.git"
									class={errors.repoUrl ? 'border-destructive focus-visible:ring-destructive' : ''}
									oninput={() => { clearPreviewState(); errors.repoUrl = undefined; }}
								/>
								{#if errors.repoUrl}
									<p class="text-xs text-destructive">{errors.repoUrl}</p>
								{/if}
							</div>
						<div class="grid grid-cols-1 sm:grid-cols-2 items-start gap-3">
								<div class="space-y-2">
									<Label for="new-repo-branch">Branch</Label>
									<!-- Free-text, searchable branch picker. Supports both discovered
									     branches and arbitrary typed names: a new/private repository whose
									     branch enumeration fails must not force the user onto "main" — they
									     can type the known branch name instead. The "main" default is
									     preserved when no branch has been chosen, and a value not returned by
									     enumeration is never silently reset. Server-side Git ref validation
									     remains authoritative. -->
									<BranchCombobox
										id="new-repo-branch"
										class="w-full max-md:min-h-11"
										value={formNewRepoBranch}
										branches={branches}
										loading={branchesLoading}
										placeholder="main"
										onchange={(v) => { clearPreviewState(); formNewRepoBranch = v; }}
										onclear={() => { clearPreviewState(); formNewRepoBranch = 'main'; }}
									/>
									<p class="text-xs text-muted-foreground">Type a name or pick from the list.</p>
								</div>
								<div class="space-y-2">
									<Label for="new-repo-credential">Credential</Label>
									<Select.Root
										type="single"
										value={formNewRepoCredentialId?.toString() ?? 'none'}
										onValueChange={(v) => { clearPreviewState(); formNewRepoCredentialId = v === 'none' ? null : parseInt(v); }}
									>
										<Select.Trigger class="w-full">
											{@const selectedCred = credentials.find(c => c.id === formNewRepoCredentialId)}
											{#if selectedCred}
												{#if selectedCred.authType === 'ssh'}
													<KeyRound class="w-4 h-4 mr-2 text-muted-foreground" />
												{:else if selectedCred.authType === 'password'}
													<Lock class="w-4 h-4 mr-2 text-muted-foreground" />
												{:else}
													<Key class="w-4 h-4 mr-2 text-muted-foreground" />
												{/if}
												<span>{selectedCred.name} ({getAuthLabel(selectedCred.authType)})</span>
											{:else}
												<Key class="w-4 h-4 mr-2 text-muted-foreground" />
												<span>None (public)</span>
											{/if}
										</Select.Trigger>
										<Select.Content>
											<Select.Item value="none">
												<span class="flex items-center gap-2">
													<Key class="w-4 h-4 text-muted-foreground" />
													None (public)
												</span>
											</Select.Item>
											{#each credentials as cred}
												<Select.Item value={cred.id.toString()}>
													<span class="flex items-center gap-2">
														{#if cred.authType === 'ssh'}
															<KeyRound class="w-4 h-4 text-muted-foreground" />
														{:else if cred.authType === 'password'}
															<Lock class="w-4 h-4 text-muted-foreground" />
														{:else}
															<Key class="w-4 h-4 text-muted-foreground" />
														{/if}
														{cred.name} ({getAuthLabel(cred.authType)})
													</span>
												</Select.Item>
											{/each}
										</Select.Content>
									</Select.Root>
									<p class="text-xs text-muted-foreground">SSH key or token for private repositories.</p>
								</div>
							</div>

							{#if isCentralizedMode}
							<div class="space-y-3 mt-4 border-t pt-4 border-muted">
								<p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Repository Sync</p>

								<!-- Auto-update section -->
								<div class="flex items-center gap-3">
									<div class="flex items-center gap-2 flex-1">
										<RefreshCw class="w-4 h-4 text-muted-foreground" />
										<Label class="text-sm font-normal">Enable scheduled sync</Label>
									</div>
									<TogglePill bind:checked={formNewRepoAutoUpdate} />
								</div>
								{#if formNewRepoAutoUpdate}
									<CronEditor
										value={formNewRepoAutoUpdateCron}
										onchange={(cron) => formNewRepoAutoUpdateCron = cron}
									/>
								{/if}

								<!-- Webhook section -->
								<div class="flex items-center gap-3 pt-2">
									<div class="flex items-center gap-2 flex-1">
										<Webhook class="w-4 h-4 text-muted-foreground" />
										<Label class="text-sm font-normal">Enable webhook</Label>
									</div>
									<TogglePill
										bind:checked={formNewRepoWebhookEnabled}
										onchange={(enabled) => { formNewRepoWebhookSecret = ensureWebhookSecret(enabled, formNewRepoWebhookSecret); }}
									/>
								</div>
								{#if formNewRepoWebhookEnabled}
									<WebhookSecretInput
										id="new-repo-webhook-secret"
										bind:value={formNewRepoWebhookSecret}
										error={errors.newRepoWebhookSecret}
										oninput={() => errors.newRepoWebhookSecret = undefined}
									/>
								{/if}
							</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<!-- Stack configuration -->
			<div class="space-y-2">
				<Label for="stack-name">Stack name</Label>
				<Input
					id="stack-name"
					bind:value={formStackName}
					placeholder="e.g., my-app"
					disabled={isAdopting}
					class="max-md:h-11 {errors.stackName ? 'border-destructive focus-visible:ring-destructive' : ''}"
					oninput={() => { errors.stackName = undefined; formStackNameUserModified = true; }}
				/>
				{#if errors.stackName}
					<p class="text-xs text-destructive">{errors.stackName}</p>
				{:else}
					<p class="text-xs text-muted-foreground">{isAdopting ? 'The existing stack name and Compose project are preserved.' : 'This will be the name of the deployed stack'}</p>
				{/if}
			</div>
			{#if isAdopting}
				<div class="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-muted-foreground">
					<p class="font-medium text-foreground">Existing services stay running.</p>
					<p class="mt-1">Compose <code class="rounded bg-muted px-1">up</code> reuses project "{adoptionTarget?.stackName}". The original directory stays in place. Select any host files you need in the Git-managed directory below.</p>
				</div>
				<div class="space-y-2">
					<Label>Copy host files or directories (optional)</Label>
					<Button variant="outline" type="button" onclick={() => showHostCopyBrowser = true}>Browse host files</Button>
					{#each hostCopyPaths as path}
						<div class="flex items-center gap-2 text-xs"><span class="break-all">{path}</span><button type="button" aria-label="Remove {path}" onclick={() => hostCopyPaths = hostCopyPaths.filter((item) => item !== path)}><X class="h-3 w-3" /></button></div>
					{/each}
					<p class="text-xs text-amber-700 dark:text-amber-300">Files tracked by Git may be overwritten by normal Git deployments. Originals are never moved.</p>
				</div>
			{/if}

			{#if gitStack?.stackName}
				<div class="space-y-2">
					<Label>Tags</Label>
					<StackTagsSection stackName={gitStack.stackName} envId={effectiveEnvId} />
				</div>
			{/if}

			{#if gitStack && selectedRepo}
				<div class="space-y-2">
					<Label>Repository</Label>
					<div class="flex h-9 max-md:h-11 items-center gap-2 rounded-md border border-input bg-muted/50 px-3 py-1 text-sm text-muted-foreground">
						<FolderGit2 class="w-4 h-4 shrink-0" />
						<span class="truncate" title={selectedRepo.url}>{selectedRepo.url}</span>
					</div>
				</div>
			{/if}

			{#if gitStack && selectedRepo}
				<div class="space-y-2">
					<Label for="stack-branch">Branch</Label>
					<BranchCombobox
									id="stack-branch"
									class="max-md:min-h-11"
						value={formBranch ?? ''}
						branches={branches}
						defaultBranch={selectedRepo.branch}
						loading={branchesLoading}
						placeholder="Repository default ({selectedRepo.branch})"
						clearLabel="Repository default ({selectedRepo.branch})"
						onchange={(v) => { formBranch = v; }}
						onclear={() => { formBranch = null; }}
					/>
					<p class="text-xs text-muted-foreground">Branch this stack deploys from. Leave empty to follow the branch configured on the repository ({selectedRepo.branch}).</p>
				</div>
			{/if}

			<div class="space-y-2">
				<Label>Compose file path{formComposePaths.length > 1 ? 's' : ''}</Label>
				{#each formComposePaths as path, i}
					{@const total = formComposePaths.length}
					{@const isDragging = gitDragIndex === i}
					<div
						class="flex items-center gap-1 {isDragging ? 'opacity-40' : ''}"
						draggable="true"
						ondragstart={(e) => gitDragStart(e, i)}
						ondragover={(e) => gitDragOver(e, i)}
						ondrop={(e) => e.preventDefault()}
						ondragend={gitDragEnd}
					>
						{#if total > 1}
							<div class="flex flex-col shrink-0 -space-y-0.5">
								<button type="button" title="Move up" disabled={i === 0}
									onclick={() => gitMovePathUp(i)} class="p-0 hover:text-muted-foreground disabled:opacity-30 disabled:cursor-default">
									<ArrowUp class="w-3 h-3" />
								</button>
								<button type="button" title="Move down" disabled={i === total - 1}
									onclick={() => gitMovePathDown(i)} class="p-0 hover:text-muted-foreground disabled:opacity-30 disabled:cursor-default">
									<ArrowDown class="w-3 h-3" />
								</button>
							</div>
							<GripVertical class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0 cursor-grab" />
							<span class="text-2xs text-muted-foreground shrink-0 w-4 text-center">{i + 1}</span>
						{/if}
						<Input
							bind:value={formComposePaths[i]}
							placeholder={i === 0 ? 'compose.yaml' : 'compose.override.yaml'}
							class="flex-1 max-md:h-11"
							oninput={() => { clearPreviewState(); if (i === 0) formComposePath = formComposePaths[i]; }}
						/>
						{#if formRepoMode === 'existing' ? !!formRepositoryId : !!formNewRepoUrl.trim()}
						<Button
							variant="outline" size="sm"
							onclick={() => gitBrowseForRow(i)}
							disabled={formRepoMode === 'existing' ? !formRepositoryId : (!formNewRepoName.trim() || !formNewRepoUrl.trim())}
							title="Browse repository" class="shrink-0">
							<FolderOpen class="w-4 h-4" />
						</Button>
						{/if}
						{#if total > 1}
							<Button variant="outline" size="sm"
									onclick={() => gitRemoveComposePath(i)}
									class="shrink-0 text-muted-foreground hover:text-destructive" title="Remove">
								<X class="w-4 h-4" />
							</Button>
						{/if}
					</div>
				{/each}
				<Button type="button" variant="ghost" size="sm" onclick={gitAddComposePath}
					class="text-xs h-auto py-1">
					+ Add compose file
				</Button>
				{#if gitBrowserError}
					<p class="text-xs text-destructive">{gitBrowserError}</p>
				{:else}
					<p class="text-xs text-muted-foreground">Paths are relative to the repository root. Order matters — files are merged left-to-right.</p>
				{/if}
			</div>

			<!-- Additional env file for variable substitution -->
			<div class="space-y-2">
				<div class="flex items-center gap-1.5">
					<Label for="env-file-path">Additional env file (optional)</Label>
					<Tooltip.Root>
						<Tooltip.Trigger>
							<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<div class="w-80">
								<p class="text-xs">A <code class="bg-muted px-1 rounded">.env</code> file in the compose directory is always loaded automatically, if present.</p>
								<p class="text-xs mt-2">Use this field for an additional env file with a non-standard name (e.g. <code class="bg-muted px-1 rounded">.env.production</code>). Its values override the default <code class="bg-muted px-1 rounded">.env</code>.</p>
								<p class="text-xs mt-2">Overrides from the environment variables editor on the right always take highest precedence.</p>
							</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
					<Input
						id="env-file-path"
						bind:value={formEnvFilePath}
						placeholder=""
							class="max-md:h-11"
							oninput={clearPreviewState}
					/>
				<p class="text-xs text-muted-foreground">{isAdopting && !formEnvFilePath ? 'Leave empty to preserve the current environment file.' : 'Additional env file to pass to Docker Compose'}</p>
			</div>

			<!-- Context directory -->
			<div class="space-y-2">
				<div class="flex items-center gap-1.5">
					<Label for="context-dir">Context directory (optional)</Label>
					<Tooltip.Root>
						<Tooltip.Trigger>
							<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
						</Tooltip.Trigger>
						<Tooltip.Content>
							<div class="w-80">
								<p class="text-xs">Working directory for Docker Compose, relative to the repository root. All files in this directory will be available for volume mounts and build contexts.</p>
								<p class="text-xs mt-2">Use <code class="bg-muted px-1 rounded">.</code> for the repository root when your compose file references files in sibling directories.</p>
								<p class="text-xs mt-2">Defaults to the compose file's parent directory.</p>
							</div>
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
				<Input
					id="context-dir"
					value={formContextDir ?? ''}
					oninput={(e) => { const v = (e.target as HTMLInputElement).value; formContextDir = v.trim() || null; }}
					placeholder="Defaults to compose file's directory"
					class="max-md:h-11"
				/>
				<p class="text-xs text-muted-foreground">Relative to repository root, e.g. <code class="text-xs bg-muted px-1 rounded">.</code> for root</p>
			</div>

			<!-- Deploy options section -->
			<div class="space-y-3 p-3 bg-muted/50 rounded-md">
				<p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Deploy options</p>
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2 flex-1">
						<Hammer class="w-4 h-4 text-muted-foreground" />
						<Label class="text-sm font-normal">Build images on deploy</Label>
					</div>
					<TogglePill bind:checked={formBuildOnDeploy} />
				</div>
				<p class="text-xs text-muted-foreground">
					Run <code class="text-xs bg-muted px-1 rounded">--build</code> to build images from Dockerfiles before starting containers.
				</p>
				{#if formBuildOnDeploy}
				<div class="flex items-center gap-3 ml-6">
					<div class="flex items-center gap-2 flex-1">
						<Ban class="w-4 h-4 text-muted-foreground" />
						<Label class="text-sm font-normal">Disable build cache</Label>
					</div>
					<TogglePill bind:checked={formNoBuildCache} />
				</div>
				<p class="text-xs text-muted-foreground ml-6">
					Pass <code class="text-xs bg-muted px-1 rounded">--no-cache</code> to force a clean build without using cached layers.
				</p>
				{/if}
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2 flex-1">
						<ArrowDownToLine class="w-4 h-4 text-muted-foreground" />
						<Label class="text-sm font-normal">Re-pull images</Label>
					</div>
					<TogglePill bind:checked={formRepullImages} />
				</div>
				<p class="text-xs text-muted-foreground">
					Always pull latest images before deploying, even if the compose file hasn't changed. Useful for CI/CD workflows with static tags like <code class="text-xs bg-muted px-1 rounded">:latest</code>.
				</p>
				<div class="flex items-center gap-3">
					<div class="flex items-center gap-2 flex-1">
						<Zap class="w-4 h-4 text-muted-foreground" />
						<Label class="text-sm font-normal">Force redeployment</Label>
					</div>
					<TogglePill bind:checked={formForceRedeploy} onchange={() => { if (!formForceRedeploy) { formStackWebhookEnabled = false; formStackWebhookSecret = ''; } }} />
				</div>
				<p class="text-xs text-muted-foreground">
					Always redeploy the stack on webhook or scheduled sync, even if no git changes are detected.
				</p>
				{#if isCentralizedMode && formForceRedeploy}
				<div class="space-y-3 ml-6 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<Webhook class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable stack webhook</Label>
							<span class="text-2xs uppercase tracking-wide text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">Stack</span>
						</div>
						<TogglePill
							bind:checked={formStackWebhookEnabled}
							onchange={(enabled) => { formStackWebhookSecret = ensureWebhookSecret(enabled, formStackWebhookSecret); }}
						/>
					</div>
					<p class="text-xs text-muted-foreground">
						Call this webhook to force redeploy <strong>this stack only</strong>. The repository-level webhook redeploys all linked stacks with force redeployment enabled.
					</p>
					<p class="text-xs text-amber-600 dark:text-amber-400">
						With a stack webhook enabled, the <strong>repository-level webhook skips this stack</strong> — it is only triggered by its own webhook, so one push won't deploy it twice.
					</p>
					{#if formStackWebhookEnabled}
						{#if gitStack}
							<WebhookUrlCopyField
								url={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/git/stacks/${gitStack.id}/webhook`}
								label="Stack webhook URL"
							/>
						{:else}
							<p class="text-xs text-muted-foreground">
								The stack webhook URL will be available after creating the stack.
							</p>
						{/if}
						<WebhookSecretInput
							id="stack-webhook-secret"
							bind:value={formStackWebhookSecret}
							error={errors.stackWebhookSecret}
							showCopy={!!gitStack}
							oninput={() => errors.stackWebhookSecret = undefined}
						/>
						<p class="text-xs text-muted-foreground">
							{#if gitStack}
								Configure this URL in your Git provider or CI/CD pipeline. Secret is used for signature verification.
							{:else}
								Secret will be saved when you create the stack.
							{/if}
						</p>
					{/if}
				</div>
				{/if}
				{#if !isCentralizedMode}
				<div class="space-y-3 p-3 bg-muted/50 rounded-md mt-3">
					<p class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Scheduled sync</p>
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<RefreshCw class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable scheduled sync</Label>
						</div>
						<TogglePill bind:checked={formStackAutoUpdate} onchange={() => { if (!formStackAutoUpdate) { formStackAutoUpdateSchedule = 'daily'; formStackAutoUpdateCron = '0 3 * * *'; } }} />
					</div>
					{#if formStackAutoUpdate}
						<div class="space-y-2">
							<Label>Frequency</Label>
							<Select.Root
								type="single"
								value={formStackAutoUpdateSchedule}
								onValueChange={(value) => {
									if (value === 'daily' || value === 'weekly' || value === 'custom') {
										formStackAutoUpdateSchedule = value;
										if (value === 'daily') formStackAutoUpdateCron = '0 3 * * *';
										if (value === 'weekly') formStackAutoUpdateCron = '0 3 * * 0';
									}
								}}
							>
								<Select.Trigger class="w-full">
									<span>{formStackAutoUpdateSchedule === 'daily' ? 'Daily' : formStackAutoUpdateSchedule === 'weekly' ? 'Weekly' : 'Custom'}</span>
								</Select.Trigger>
								<Select.Content>
									<Select.Item value="daily"><span>Daily</span></Select.Item>
									<Select.Item value="weekly"><span>Weekly</span></Select.Item>
									<Select.Item value="custom"><span>Custom (cron)</span></Select.Item>
								</Select.Content>
							</Select.Root>
							{#if formStackAutoUpdateSchedule === 'custom'}
								<CronEditor
									value={formStackAutoUpdateCron}
									onchange={(cron) => formStackAutoUpdateCron = cron}
								/>
							{/if}
						</div>
					{/if}

					<div class="flex items-center gap-3 pt-2">
						<div class="flex items-center gap-2 flex-1">
							<Webhook class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable webhook</Label>
						</div>
						<TogglePill
							bind:checked={formStackWebhookEnabled}
							onchange={(enabled) => { formStackWebhookSecret = ensureWebhookSecret(enabled, formStackWebhookSecret); }}
						/>
					</div>
					<p class="text-xs text-muted-foreground">
						Deploy this stack when the webhook URL is called. Configure the URL and secret in your Git provider or CI/CD pipeline.
					</p>
					{#if formStackWebhookEnabled}
						{#if gitStack}
							<WebhookUrlCopyField
								url={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/git/stacks/${gitStack.id}/webhook`}
								label="Stack webhook URL"
							/>
						{:else}
							<p class="text-xs text-muted-foreground">
								The stack webhook URL will be available after creating the stack.
							</p>
						{/if}
						<WebhookSecretInput
							id="stack-webhook-secret"
							bind:value={formStackWebhookSecret}
							error={errors.stackWebhookSecret}
							showCopy={!!gitStack}
							oninput={() => errors.stackWebhookSecret = undefined}
						/>
					{/if}
				</div>
				{/if}
			</div>

			<!-- Deploy now option (only for new stacks) -->
			{#if !gitStack}
				<div class="space-y-3 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<Rocket class="w-4 h-4 text-muted-foreground" />
							<div class="flex-1">
								<Label class="text-sm font-normal">Deploy now</Label>
								<p class="text-xs text-muted-foreground">Clone and deploy the stack immediately</p>
							</div>
						</div>
						<TogglePill bind:checked={formDeployNow} />
					</div>
				</div>
			{/if}

			{#if formError}
				<p class="text-sm text-destructive">{formError}</p>
			{/if}
				</div>
			</div>

		</div>
		{/if}

		<Dialog.Footer class="px-5 py-2.5 border-t border-zinc-200 dark:border-zinc-700 flex-shrink-0 max-md:grid max-md:w-full max-md:grid-cols-2 max-md:gap-2 max-md:pb-[max(0.625rem,env(safe-area-inset-bottom))]">
			<Button variant="outline" class="max-md:order-3 max-md:min-h-11 max-md:w-full" onclick={onClose}>{activeTab === 'backups' ? 'Close' : 'Cancel'}</Button>
			<!-- The deploy-form save buttons belong to the Settings tab. On the Backups
			     tab the backup panel manages its own saving, so only Close is shown. -->
			{#if activeTab !== 'backups'}
				{#if gitStack}
					<Button variant="outline" class="max-md:order-1 max-md:col-span-2 max-md:min-h-11 max-md:w-full" onclick={() => saveGitStack(true)} disabled={formSaving}>
						{#if formSaving}
							<Loader2 class="w-4 h-4 mr-1 animate-spin" />
							Deploying...
						{:else}
							<Rocket class="w-4 h-4" />
							Save and deploy
						{/if}
					</Button>
					<Button class="max-md:order-2 max-md:min-h-11 max-md:w-full" onclick={() => saveGitStack(false)} disabled={formSaving}>
						{#if formSaving}
							<Loader2 class="w-4 h-4 mr-1 animate-spin" />
							Saving...
						{:else}
							Save changes
						{/if}
					</Button>
				{:else if isAdopting}
					<Button class="max-md:order-1 max-md:col-span-2 max-md:min-h-11 max-md:w-full" onclick={() => saveGitStack(true)} disabled={formSaving}>
						{#if formSaving}
							<Loader2 class="w-4 h-4 mr-1 animate-spin" />
							Adopting...
						{:else}
							<Rocket class="w-4 h-4" />
							Deploy from Git
						{/if}
					</Button>
				{:else}
					<Button class="max-md:order-1 max-md:col-span-2 max-md:min-h-11 max-md:w-full" onclick={() => saveGitStack(formDeployNow)} disabled={formSaving}>
						{#if formSaving}
							<Loader2 class="w-4 h-4 mr-1 animate-spin" />
							{formDeployNow ? 'Deploying...' : 'Creating...'}
						{:else}
							{formDeployNow ? 'Deploy' : 'Create'}
						{/if}
					</Button>
				{/if}
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Stack already exists warning dialog -->
<Dialog.Root bind:open={showExistsWarning}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<TriangleAlert class="w-5 h-5 text-amber-500" />
				Stack already exists
			</Dialog.Title>
			<Dialog.Description>
				A stack named "{formStackName}" already exists. Please choose a different name.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex justify-end mt-4">
			<Button size="sm" onclick={() => showExistsWarning = false}>
				OK
			</Button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<IconPickerModal bind:open={showIconPicker} value={formIcon} onselect={onIconSelect} title="Choose a stack icon" />

<!-- Live compose output for "Save and deploy" (see saveGitStack). -->
<ComposeOutputModal
	bind:open={outputOpen}
	title={outputTitle}
	lines={outputLines}
	running={outputRunning}
	ok={outputOk}
	ms={outputMs}
	exitCode={outputExitCode}
	stackName={formStackName}
	stackIcon={formIcon}
	envId={effectiveEnvId}
/>

<!-- Git repository filesystem browser -->
<FilesystemBrowser
	bind:open={showHostCopyBrowser}
	title="Select host files or directories to copy"
	description="Browse the filesystem visible to the process that will copy these items"
	selectMode="file_or_directory"
	multiSelect
	apiUrl={appendEnvParam('/api/stacks/host-files', effectiveEnvId)}
	onSelect={(path) => hostCopyPaths = [...new Set([...hostCopyPaths, path])]}
	onSelectMany={(entries) => hostCopyPaths = [...new Set([...hostCopyPaths, ...entries.map((entry) => entry.path)])]}
	onClose={() => showHostCopyBrowser = false}
/>
<!-- Opens when user clicks Browse next to the compose file path field -->
<FilesystemBrowser
	bind:open={showGitRepoBrowser}
	title={gitBrowserPurpose === 'link' ? 'Link configuration file' : 'Select compose file(s)'}
	icon={FolderGit2}
	description={gitBrowserPurpose === 'link' ? 'Choose a text file from the Compose directory' : 'Select one or more compose files from the repository'}
	initialPath={gitBrowserInitialPath}
	selectFilter={gitBrowserPurpose === 'link' ? /.*/ : /\.ya?ml$/i}
	selectMode="file"
	apiUrl={gitBrowserApiUrl}
	bind:rootPath={gitBrowserRootPath}
	bind:cloningMessage={gitBrowserCloningMessage}
	onSelect={gitBrowserPurpose === 'link' ? selectGitDraftLink : gitBrowseForRowIndex !== null ? gitHandleRowBrowseSelect : ((path, name) => handleGitMultiBrowseSelect([{ path, name }]))}
	multiSelect={gitBrowserPurpose === 'compose' && gitBrowseForRowIndex === null}
	onSelectMany={gitBrowserPurpose === 'compose' && gitBrowseForRowIndex === null ? handleGitMultiBrowseSelect : undefined}
	onClose={() => {
		showGitRepoBrowser = false;
		gitBrowserCloningMessage = undefined;
		gitBrowseForRowIndex = null;
		gitBrowserPurpose = 'compose';
		gitBrowserInitialPath = '';
	}}
/>

<!-- Cloning Progress Dialog for newly added repo inside Stack creation -->
<Dialog.Root open={cloneStatus === 'cloning' || cloneStatus === 'error'} onOpenChange={(v) => { if (!v) { cloneStatus = 'idle'; stopPolling(); } }}>
	<Dialog.Content class="max-w-lg">
		{#if cloneStatus === 'cloning'}
			<!-- ── Cloning state ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2">
					<GitFork class="w-5 h-5" />
					Cloning repository…
				</Dialog.Title>
				<Dialog.Description>
					Please wait while the repository is being cloned. This may take a moment.
				</Dialog.Description>
			</Dialog.Header>
			<div class="flex flex-col items-center justify-center gap-4 py-10">
				<Loader2 class="w-10 h-10 animate-spin text-muted-foreground" />
				<p class="text-sm text-muted-foreground">Cloning from <span class="font-mono text-foreground">{formNewRepoUrl}</span>…</p>
			</div>
		{:else if cloneStatus === 'error'}
			<!-- ── Error state ── -->
			<Dialog.Header>
				<Dialog.Title class="flex items-center gap-2 text-destructive">
					<XCircle class="w-5 h-5" />
					Clone failed
				</Dialog.Title>
				<Dialog.Description>
					The repository was saved but could not be cloned. Check the error below.
				</Dialog.Description>
			</Dialog.Header>
			<div class="rounded-md border border-destructive/40 bg-destructive/5 p-4 my-2">
				<p class="text-sm font-medium text-destructive mb-1">Git error</p>
				<pre class="text-xs text-destructive/90 whitespace-pre-wrap break-all font-mono">{cloneError}</pre>
			</div>
			<p class="text-xs text-muted-foreground">
				You can fix the URL or credentials to retry, or delete it to start over.
			</p>
			<Dialog.Footer class="gap-2 flex-col sm:flex-row">
				<Button variant="destructive" onclick={deleteRepositoryAndClose}>
					Delete repository
				</Button>
				<Button variant="outline" onclick={() => { cloneStatus = 'idle'; stopPolling(); }}>Close</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
