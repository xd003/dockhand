<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Label } from '$lib/components/ui/label';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import { Loader2, GitBranch, RefreshCw, Webhook, Rocket, RefreshCcw, Copy, Check, XCircle, FolderGit2, Github, Key, KeyRound, Lock, FileText, HelpCircle, GripVertical, X, Download, Hammer, ArrowDownToLine, Zap, FolderOpen, Ban, TriangleAlert, GitFork } from 'lucide-svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { copyToClipboard } from '$lib/utils/clipboard';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import StackEnvVarsPanel from '$lib/components/StackEnvVarsPanel.svelte';
	import { type EnvVar, type ValidationResult } from '$lib/components/StackEnvVarsEditor.svelte';
	import { toast } from 'svelte-sonner';
	import { focusFirstInput } from '$lib/utils';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { useSidebar } from '$lib/components/ui/sidebar/context.svelte';
	import FilesystemBrowser from './FilesystemBrowser.svelte';

	// Get sidebar state to adjust modal positioning
	const sidebar = useSidebar();

	// localStorage key for persisted split ratio
	const STORAGE_KEY_SPLIT = 'dockhand-git-stack-modal-split';

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
		credential_id: number | null;
	}

	interface GitStack {
		id: number;
		stackName: string;
		repositoryId: number;
		environmentId: number | null;
		composePath: string;
		envFilePath: string | null;
		contextDir: string | null;
		buildOnDeploy: boolean;
		noBuildCache: boolean;
		repullImages: boolean;
		forceRedeploy: boolean;
		webhookEnabled: boolean;
		webhookSecret: string | null;
	}

	interface Props {
		open: boolean;
		gitStack?: GitStack | null;
		environmentId?: number | null;
		repositories: GitRepository[];
		credentials: GitCredential[];
		onClose: () => void;
		onSaved: () => void;
		/** Called when a new repository is created inline (via Browse) so the parent can refresh the repos list */
		onRepositoryCreated?: () => void;
	}

	let { open = $bindable(), gitStack = null, environmentId = null, repositories, credentials, onClose, onSaved, onRepositoryCreated }: Props = $props();

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

	// Form state - stack deployment config
	let formStackName = $state('');
	let formStackNameUserModified = $state(false);
	let formComposePath = $state('compose.yaml');
	let formContextDir = $state<string | null>(null);
	let formBuildOnDeploy = $state(false);
	let formNoBuildCache = $state(false);
	let formRepullImages = $state(false);
	let formForceRedeploy = $state(false);
	let formStackWebhookEnabled = $state(false);
	let formStackWebhookSecret = $state('');
	let copiedStackWebhookUrl = $state<'' | 'ok' | 'error'>('');
	let copiedStackWebhookSecret = $state<'' | 'ok' | 'error'>('');
	let formDeployNow = $state(false);
	let formError = $state('');
	let formSaving = $state(false);
	let showExistsWarning = $state(false);
	let errors = $state<{ stackName?: string; repository?: string; repoName?: string; repoUrl?: string }>({});

	// Stack name validation: must start with alphanumeric, can contain alphanumeric, hyphens, underscores
	const STACK_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

	// Environment variables state
	let formEnvFilePath = $state<string | null>(null);
	let envFiles = $state<string[]>([]);
	let loadingEnvFiles = $state(false);
	let envVars = $state<EnvVar[]>([]);
	let fileEnvVars = $state<Record<string, string>>({});
	let loadingFileVars = $state(false);
	let existingSecretKeys = $state<Set<string>>(new Set());
	let populatingEnvVars = $state(false);

	// Resizable split panel state
	let splitRatio = $state(60); // percentage for form panel
	let isDraggingSplit = $state(false);
	let containerRef: HTMLDivElement | null = $state(null);


	// Git repository browse state
	let showGitRepoBrowser = $state(false);
	let gitBrowserApiUrl = $state('');
	let gitBrowserRootPath = $state('');
	let gitBrowserCloningMessage = $state<string | undefined>(undefined);
	let gitBrowserError = $state<string | null>(null);
	/** Tracks whether formComposePath was set by the Browse button (vs. typed manually) */
	let formComposePathBrowsed = $state(false);

	let cloneStatus = $state<'idle' | 'cloning' | 'success' | 'error'>('idle');
	let cloneError = $state<string | null>(null);
	let cloningRepoId = $state<number | null>(null);
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function stopPolling() {
		if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
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

	async function pollJob(jobId: string, repoId: number) {
		try {
			const res = await fetch(`/api/jobs/${jobId}`);
			if (!res.ok) {
				stopPolling();
				cloneStatus = 'error';
				cloneError = 'Could not retrieve clone status. The repository may still be cloning in the background.';
				return;
			}
			const job = await res.json();
			if (job.status === 'done') {
				stopPolling();
				cloneStatus = 'success';
				cloningRepoId = null;
				onRepositoryCreated?.(); // refresh list
				// Switch to 'existing' mode so the stack-save flow uses the real repo ID
				formRepositoryId = repoId;
				formRepoMode = 'existing';
				gitBrowserApiUrl = `/api/git/repositories/${repoId}/browse`;
				gitBrowserRootPath = '';
				showGitRepoBrowser = true;
				cloneStatus = 'idle';
			} else if (job.status === 'error') {
				stopPolling();
				cloneStatus = 'error';
				// Keep cloningRepoId set so they can delete it
				cloneError = (job.result as any)?.error ?? 'Clone failed — check the repository URL and credentials.';
				onRepositoryCreated?.();
			}
			// status === 'running' → keep polling
		} catch {
			// Network error — keep polling silently
		}
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
	});

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

	async function loadEnvFileContents(path: string) {
		if (!gitStack || !path) {
			fileEnvVars = {};
			return;
		}

		loadingFileVars = true;
		try {
			const response = await fetch(`/api/git/stacks/${gitStack.id}/env-files`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path })
			});
			if (response.ok) {
				const data = await response.json();
				fileEnvVars = data.vars || {};
			}
		} catch (e) {
			console.error('Failed to load env file contents:', e);
			fileEnvVars = {};
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
			}
		} catch (e) {
			console.error('Failed to load env var overrides:', e);
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

		populatingEnvVars = true;
		try {
			const body: Record<string, any> = {
				composePath: formComposePath || 'compose.yaml',
				envFilePath: formEnvFilePath || null
			};

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
			} else {
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
			}

			const response = await fetch('/api/git/preview-env', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = await response.json();

			if (!response.ok) {
				toast.error('Failed to load env variables', {
					description: data.error || 'Unknown error'
				});
				return;
			}

			const vars = data.vars as Record<string, string>;
			const count = Object.keys(vars).length;

			if (count === 0) {
				toast.info('No environment variables found', {
					description: 'No .env files found in the repository. You can still add variables manually.'
				});
				return;
			}

			// Convert to EnvVar array - preserve existing user entries that aren't in repo
			const existingUserVars = envVars.filter(v => v.key.trim() && !(v.key in vars));
			const newVars: EnvVar[] = Object.entries(vars).map(([key, value]) => ({
				key,
				value,
				isSecret: false
			}));

			envVars = [...newVars, ...existingUserVars];
			fileEnvVars = vars;

			toast.success(`Loaded ${count} variable${count === 1 ? '' : 's'}`, {
				description: 'You can now customize values before deploying'
			});
		} catch (e) {
			console.error('Failed to populate env vars:', e);
			toast.error('Failed to load env variables');
		} finally {
			populatingEnvVars = false;
		}
	}

	async function resetForm() {
		// Clear state BEFORE async loads to avoid race conditions
		formError = '';
		errors = {};
		envFiles = [];
		envVars = [];
		fileEnvVars = {};
		existingSecretKeys = new Set();

		if (gitStack) {
			formRepoMode = 'existing';
			formRepositoryId = gitStack.repositoryId;
			formStackName = gitStack.stackName;
			formComposePath = gitStack.composePath;
			formEnvFilePath = gitStack.envFilePath;
			formContextDir = gitStack.contextDir ?? null;
			formBuildOnDeploy = gitStack.buildOnDeploy ?? false;
			formNoBuildCache = gitStack.noBuildCache ?? false;
			formRepullImages = gitStack.repullImages ?? false;
			formForceRedeploy = gitStack.forceRedeploy ?? false;
			formStackWebhookEnabled = gitStack.webhookEnabled ?? false;
			formStackWebhookSecret = gitStack.webhookSecret || '';
			formDeployNow = false;

			// Load env files and overrides SYNCHRONOUSLY to avoid race conditions
			// Wait for all loads to complete before allowing any other effect to run
			await Promise.all([
				loadEnvFiles(),
				loadEnvVarsOverrides(),
				gitStack.envFilePath ? loadEnvFileContents(gitStack.envFilePath) : Promise.resolve()
			]);
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
			formComposePathBrowsed = false;
			formEnvFilePath = null;
			formContextDir = null;
			formBuildOnDeploy = false;
			formNoBuildCache = false;
			formRepullImages = false;
			formForceRedeploy = false;
			formStackWebhookEnabled = false;
			formStackWebhookSecret = '';
			copiedStackWebhookUrl = '';
			copiedStackWebhookSecret = '';
			formDeployNow = false;
		}
	}

	async function saveGitStack(deployAfterSave: boolean = false) {
		errors = {};
		let hasErrors = false;

		const trimmedStackName = formStackName.trim();
		if (!trimmedStackName) {
			errors.stackName = 'Stack name is required';
			hasErrors = true;
		} else if (!STACK_NAME_REGEX.test(trimmedStackName)) {
			errors.stackName = 'Stack name must start with a letter or number, and contain only letters, numbers, hyphens, and underscores';
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

		if (hasErrors) return;

		// Check if stack already exists (only for new stacks)
		if (!gitStack) {
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
			// Only save vars that are actual overrides (differ from file) or new (not in file)
			// This ensures file updates from git are picked up on next sync
			const overrideVars = envVars.filter(v => {
				if (!v.key.trim()) return false;
				const fileValue = fileEnvVars[v.key];
				// Save if: not in file (new var), value differs from file, or is a secret
				return fileValue === undefined || v.value !== fileValue || v.isSecret;
			});

			let body: any = {
				stackName: formStackName,
				composePath: formComposePath || 'compose.yaml',
				envFilePath: formEnvFilePath,
				environmentId: environmentId,
				contextDir: formContextDir || null,
				buildOnDeploy: formBuildOnDeploy,
				noBuildCache: formNoBuildCache,
				repullImages: formRepullImages,
				forceRedeploy: formForceRedeploy,
				webhookEnabled: formForceRedeploy ? formStackWebhookEnabled : false,
				webhookSecret: (formForceRedeploy && formStackWebhookEnabled) ? formStackWebhookSecret || null : null,
				deployNow: deployAfterSave,
				envVars: overrideVars.map(v => ({
					key: v.key.trim(),
					value: v.value,
					isSecret: v.isSecret
				}))
			};

			if (formRepoMode === 'existing') {
				body.repositoryId = formRepositoryId;
			} else {
				// Create new repo inline
				body.repoName = formNewRepoName;
				body.url = formNewRepoUrl;
				body.branch = formNewRepoBranch || 'main';
				body.credentialId = formNewRepoCredentialId;
				body.autoUpdate = formNewRepoAutoUpdate;
				body.autoUpdateCron = formNewRepoAutoUpdateCron;
				body.webhookEnabled = formNewRepoWebhookEnabled;
				body.webhookSecret = formNewRepoWebhookEnabled ? formNewRepoWebhookSecret : null;
			}

			const url = gitStack
				? `/api/git/stacks/${gitStack.id}`
				: '/api/git/stacks';
			const method = gitStack ? 'PUT' : 'POST';

			const response = await fetch(url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});

			const data = await readJobResponse(response);

			if (!response.ok) {
				formError = data.error || 'Failed to save git stack';
				return;
			}

			// Check if deployment failed
			if (data.deployResult && !data.deployResult.success) {
				toast.error('Deployment failed', {
					description: data.deployResult.error || 'Unknown error'
				});
				onSaved(); // Still refresh the list to show the new stack
				onClose(); // Close modal, error shown as toast
				return;
			}

			onSaved();
			onClose();
		} catch (error) {
			formError = 'Failed to save git stack';
		} finally {
			formSaving = false;
		}
	}

	// Auto-populate stack name from selected repo and compose path (only if user hasn't manually edited)
	// Auto-populate stack name from selected repo and compose path (only if user hasn't manually edited
	// AND the path wasn't set via the Browse button — Browse already sets the optimal name from parent dir).
	$effect(() => {
		if (formRepoMode === 'existing' && formRepositoryId && !gitStack && !formStackNameUserModified && !formComposePathBrowsed) {
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

	/**
	 * Open the FilesystemBrowser scoped to a git repository's clone directory.
	 *
	 * For "existing" repos: opens the browse dialog immediately. The browse API
	 * will clone the repo synchronously on first request if it isn't on disk yet.
	 *
	 * For "new" repos: creates the repository in the DB first (giving it a real
	 * ID, standard clone path, and making it visible in the dropdown for future
	 * stacks), then opens the browse API for the newly created repo.
	 */
	async function openGitRepoBrowser() {
		gitBrowserError = null;

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
				if (existingRepo) {
					// Reuse the existing repository — no duplicate created
					repoId = existingRepo.id;
					formNewRepoName = existingRepo.name;

					formRepositoryId = repoId;
					formRepoMode = 'existing';
					gitBrowserApiUrl = `/api/git/repositories/${repoId}/browse`;
					gitBrowserRootPath = '';
					showGitRepoBrowser = true;
				} else {
					// Create the repository in the DB (also triggers background clone-on-save)
					const res = await fetch('/api/git/repositories', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
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

					cloneStatus = 'cloning';
					cloneError = null;
					cloningRepoId = repoId;
					pollJob(data.jobId, repoId);
					pollTimer = setInterval(() => pollJob(data.jobId, repoId), 1500);
				}
			} catch (e) {
				gitBrowserError = 'Failed to save repository';
				toast.error('Failed to save repository');
			}
		} else {
			// Existing repo — open browse dialog immediately.
			// The browse API will pull latest changes before listing (or clone if not on disk yet).
			gitBrowserApiUrl = `/api/git/repositories/${formRepositoryId}/browse`;
			gitBrowserRootPath = '';
			showGitRepoBrowser = true;
		}
	}

	/**
	 * Called when the user selects a file in the git repo browser.
	 * Converts the absolute clone path to a repo-relative path, stores it in
	 * formComposePath, and auto-derives the stack name from the parent directory
	 * (e.g. selecting "immich/compose.yaml" → stack name defaults to "immich").
	 */
	function handleGitBrowseSelect(absolutePath: string, _name: string) {
		// Compute repo-relative path by stripping the repo root prefix
		const relativePath = gitBrowserRootPath && absolutePath.startsWith(gitBrowserRootPath)
			? absolutePath.slice(gitBrowserRootPath.length).replace(/^\//, '')
			: absolutePath;

		formComposePath = relativePath;
		formComposePathBrowsed = true;

		// Auto-set stack name from the parent directory of the selected compose file
		// (only if the user hasn't manually typed a name)
		if (!formStackNameUserModified) {
			const parts = relativePath.split('/');
			if (parts.length >= 2) {
				// e.g. "immich/compose.yaml" → parent dir is "immich"
				const parentDir = parts[parts.length - 2];
				formStackName = parentDir
					.toLowerCase()
					.replace(/[\s_]+/g, '-')
					.replace(/[^a-z0-9-]/g, '')
					.replace(/-+/g, '-')
					.replace(/^-|-$/g, '');
			}
			// If file is at repo root (parts.length === 1), the $effect will pick
			// up the typed repo name since formComposePathBrowsed is still true but
			// there's no parent dir to extract — leave formStackName unchanged.
		}

		showGitRepoBrowser = false;
		gitBrowserCloningMessage = undefined;
	}
</script>

<Dialog.Root bind:open onOpenChange={(isOpen) => { if (isOpen) focusFirstInput(); }}>
	<Dialog.Content
		class="max-w-none h-[95vh] flex flex-col p-0 gap-0 shadow-xl border-zinc-200 dark:border-zinc-700 {sidebar.state === 'collapsed' ? 'w-[calc(100vw-6rem)] ml-[1.5rem]' : 'w-[calc(100vw-12rem)] ml-[4.5rem]'}"
		showCloseButton={false}
	>
		<Dialog.Header class="px-5 py-3 border-b border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<div class="flex items-center justify-between">
				<div class="flex items-center gap-3">
					<div class="p-1.5 rounded-md bg-zinc-200 dark:bg-zinc-700">
						<GitBranch class="w-4 h-4 text-zinc-600 dark:text-zinc-300" />
					</div>
					<div>
						<Dialog.Title class="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
							{gitStack ? 'Edit git stack' : 'Deploy from Git'}
						</Dialog.Title>
						<Dialog.Description class="text-xs text-zinc-500 dark:text-zinc-400">
							{gitStack ? 'Update git stack settings' : 'Deploy a compose stack from a Git repository'}
						</Dialog.Description>
					</div>
				</div>

				<!-- Close button -->
				<button
					onclick={onClose}
					class="p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
				>
					<X class="w-4 h-4" />
				</button>
			</div>
		</Dialog.Header>

		<div bind:this={containerRef} class="flex-1 min-h-0 flex {isDraggingSplit ? 'select-none' : ''}">
			<!-- Left column: Form fields -->
			<div class="flex-shrink-0 flex flex-col min-w-0 overflow-y-auto" style="width: {splitRatio}%">
				<div class="space-y-4 py-4 px-6">
			<!-- Repository selection -->
			{#if !gitStack}
				<div class="space-y-3">
					<Label>Repository</Label>
					<div class="flex gap-2">
						<Button
							variant={formRepoMode === 'existing' ? 'default' : 'outline'}
							size="sm"
							onclick={() => formRepoMode = 'existing'}
							disabled={repositories.length === 0}
						>
							Select existing
						</Button>
						<Button
							variant={formRepoMode === 'new' ? 'default' : 'outline'}
							size="sm"
							onclick={() => formRepoMode = 'new'}
						>
							Add new
						</Button>
					</div>

					{#if formRepoMode === 'existing'}
						<Select.Root
							type="single"
							value={formRepositoryId?.toString() ?? ''}
							onValueChange={(v) => { formRepositoryId = v ? parseInt(v) : null; errors.repository = undefined; }}
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
									oninput={() => errors.repoUrl = undefined}
								/>
								{#if errors.repoUrl}
									<p class="text-xs text-destructive">{errors.repoUrl}</p>
								{/if}
							</div>
							<div class="grid grid-cols-2 gap-3">
								<div class="space-y-2">
									<Label for="new-repo-branch">Branch</Label>
									<Input id="new-repo-branch" bind:value={formNewRepoBranch} placeholder="main" />
								</div>
								<div class="space-y-2">
									<Label for="new-repo-credential">Credential</Label>
									<Select.Root
										type="single"
										value={formNewRepoCredentialId?.toString() ?? 'none'}
										onValueChange={(v) => formNewRepoCredentialId = v === 'none' ? null : parseInt(v)}
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
								</div>
							</div>
							
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
									<TogglePill bind:checked={formNewRepoWebhookEnabled} />
								</div>
								{#if formNewRepoWebhookEnabled}
									<div class="space-y-2">
										<Label for="new-repo-webhook-secret">Webhook secret (optional)</Label>
										<div class="flex gap-2">
											<Input
												id="new-repo-webhook-secret"
												bind:value={formNewRepoWebhookSecret}
												placeholder="Leave empty for no signature verification"
												class="font-mono text-xs"
											/>
											<Tooltip.Root>
												<Tooltip.Trigger>
													<Button
														variant="outline"
														size="sm"
														type="button"
														onclick={() => {
															const array = new Uint8Array(24);
															crypto.getRandomValues(array);
															formNewRepoWebhookSecret = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
														}}
													>
														<Key class="w-4 h-4" />
													</Button>
												</Tooltip.Trigger>
												<Tooltip.Content>Generate secret</Tooltip.Content>
											</Tooltip.Root>
										</div>
									</div>
								{/if}
							</div>
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
					class={errors.stackName ? 'border-destructive focus-visible:ring-destructive' : ''}
					oninput={() => { errors.stackName = undefined; formStackNameUserModified = true; }}
				/>
				{#if errors.stackName}
					<p class="text-xs text-destructive">{errors.stackName}</p>
				{:else}
					<p class="text-xs text-muted-foreground">This will be the name of the deployed stack</p>
				{/if}
			</div>

			{#if gitStack && selectedRepo}
				<div class="space-y-2">
					<Label>Repository</Label>
					<div class="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
						<FolderGit2 class="w-3.5 h-3.5 shrink-0" />
						<span class="truncate" title={selectedRepo.url}>{selectedRepo.url}</span>
						{#if selectedRepo.branch}
							<Badge variant="outline" class="text-2xs py-0 px-1.5 shrink-0">{selectedRepo.branch}</Badge>
						{/if}
					</div>
				</div>
			{/if}

			<div class="space-y-2">
				<Label for="compose-path">Compose file path</Label>
				<div class="flex gap-2">
					<Input
						id="compose-path"
						bind:value={formComposePath}
						placeholder="compose.yaml"
						class="flex-1"
						oninput={() => { formComposePathBrowsed = false; }}
					/>
					<Button
						variant="outline"
						size="sm"
						onclick={openGitRepoBrowser}
						disabled={formRepoMode === 'existing' ? !formRepositoryId : (!formNewRepoName.trim() || !formNewRepoUrl.trim())}
						title="Browse repository for compose file"
						class="shrink-0"
					>
						<FolderOpen class="w-4 h-4" />
						Browse
					</Button>
				</div>
				{#if gitBrowserError}
					<p class="text-xs text-destructive">{gitBrowserError}</p>
				{:else if formComposePathBrowsed}
					<p class="text-xs text-green-600 dark:text-green-400">✓ Selected from repository</p>
				{:else}
					<p class="text-xs text-muted-foreground">Path to the compose file within the repository, or click Browse to select</p>
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
					/>
				<p class="text-xs text-muted-foreground">Additional env file to pass to Docker Compose</p>
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
				{#if formForceRedeploy}
				<div class="space-y-3 ml-6 p-3 bg-muted/50 rounded-md">
					<div class="flex items-center gap-3">
						<div class="flex items-center gap-2 flex-1">
							<Webhook class="w-4 h-4 text-muted-foreground" />
							<Label class="text-sm font-normal">Enable stack webhook</Label>
						</div>
						<TogglePill bind:checked={formStackWebhookEnabled} />
					</div>
					<p class="text-xs text-muted-foreground">
						Call this webhook to force redeploy <strong>this stack only</strong>. The repository-level webhook redeploys all linked stacks with force redeployment enabled.
					</p>
					{#if formStackWebhookEnabled}
						{#if gitStack}
							<div class="space-y-2">
								<Label>Stack webhook URL</Label>
								<div class="flex gap-2">
									<Input
										value={`${typeof window !== 'undefined' ? window.location.origin : ''}/api/git/stacks/${gitStack.id}/webhook`}
										readonly
										class="font-mono text-xs bg-background"
									/>
									<Button
										variant="outline"
										size="sm"
										onclick={async () => {
											const result = await copyToClipboard(`${window.location.origin}/api/git/stacks/${gitStack.id}/webhook`);
											copiedStackWebhookUrl = result ? 'ok' : 'error';
											setTimeout(() => copiedStackWebhookUrl = '', 2000);
										}}
										title="Copy URL"
									>
										{#if copiedStackWebhookUrl === 'error'}
											<Tooltip.Root open>
												<Tooltip.Trigger><XCircle class="w-4 h-4 text-red-500" /></Tooltip.Trigger>
												<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
											</Tooltip.Root>
										{:else if copiedStackWebhookUrl === 'ok'}
											<Check class="w-4 h-4 text-green-500" />
										{:else}
											<Copy class="w-4 h-4" />
										{/if}
									</Button>
								</div>
							</div>
						{:else}
							<p class="text-xs text-muted-foreground">
								The stack webhook URL will be available after creating the stack.
							</p>
						{/if}
						<div class="space-y-2">
							<Label for="stack-webhook-secret">Webhook secret (optional)</Label>
							<div class="flex gap-2">
								<Input
									id="stack-webhook-secret"
									bind:value={formStackWebhookSecret}
									placeholder="Leave empty for no signature verification"
									class="font-mono text-xs"
								/>
								{#if gitStack && formStackWebhookSecret}
									<Button
										variant="outline"
										size="sm"
										onclick={async () => {
											const result = await copyToClipboard(formStackWebhookSecret);
											copiedStackWebhookSecret = result ? 'ok' : 'error';
											setTimeout(() => copiedStackWebhookSecret = '', 2000);
										}}
										title="Copy secret"
									>
										{#if copiedStackWebhookSecret === 'error'}
											<Tooltip.Root open>
												<Tooltip.Trigger><XCircle class="w-4 h-4 text-red-500" /></Tooltip.Trigger>
												<Tooltip.Content>Copy requires HTTPS</Tooltip.Content>
											</Tooltip.Root>
										{:else if copiedStackWebhookSecret === 'ok'}
											<Check class="w-4 h-4 text-green-500" />
										{:else}
											<Copy class="w-4 h-4" />
										{/if}
									</Button>
								{/if}
								<Tooltip.Root>
									<Tooltip.Trigger>
										<Button
											variant="outline"
											size="sm"
											onclick={() => {
												const arr = new Uint8Array(32);
												crypto.getRandomValues(arr);
												formStackWebhookSecret = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
											}}
										>
											<Key class="w-4 h-4" />
										</Button>
									</Tooltip.Trigger>
									<Tooltip.Content>Generate secret</Tooltip.Content>
								</Tooltip.Root>
							</div>
							<p class="text-xs text-muted-foreground">
								{#if gitStack}
									Configure this URL in your Git provider or CI/CD pipeline. Secret is used for signature verification.
								{:else}
									Secret will be saved when you create the stack.
								{/if}
							</p>
						</div>
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

			<!-- Resizable divider -->
			<div
				class="w-1 flex-shrink-0 bg-zinc-200 dark:bg-zinc-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors flex items-center justify-center group {isDraggingSplit ? 'bg-blue-500 dark:bg-blue-400' : ''}"
				onmousedown={startSplitDrag}
				role="separator"
				aria-orientation="vertical"
				tabindex="0"
			>
				<div class="w-4 h-8 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity {isDraggingSplit ? 'opacity-100' : ''}">
					<GripVertical class="w-3 h-3 text-white" />
				</div>
			</div>

			<!-- Right column: Environment Variables -->
			<div class="flex-1 min-w-0 flex flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-800/50">
				<StackEnvVarsPanel
					bind:variables={envVars}
					placeholder={{ key: 'MY_VAR', value: 'value' }}
					infoText="Override variables from your repository env files. Non-secrets are saved to <code class='bg-muted px-1 rounded'>.env.dockhand</code> in the stack directory. Secrets are stored in the database and injected via shell environment at deploy time.<br/><br/>Variables are available for <strong>compose file interpolation</strong> using <code class='bg-muted px-1 rounded'>${'{VAR_NAME}'}</code> syntax. They are not automatically injected into containers — use <code class='bg-muted px-1 rounded'>environment:</code> or reference <code class='bg-muted px-1 rounded'>.env.dockhand</code> in <code class='bg-muted px-1 rounded'>env_file:</code> to pass them through."
					existingSecretKeys={gitStack !== null ? existingSecretKeys : new Set()}
					showInterpolationHint={true}
				>
					{#snippet headerActions()}
						{#if !gitStack}
							<div class="flex items-center gap-0.5">
								<Button
									type="button"
									size="sm"
									variant="ghost"
									onclick={populateEnvVars}
									disabled={populatingEnvVars || (formRepoMode === 'existing' && !formRepositoryId) || (formRepoMode === 'new' && !formNewRepoUrl.trim())}
									class="h-6 text-xs px-2"
								>
									{#if populatingEnvVars}
										<Loader2 class="w-3.5 h-3.5 mr-1 animate-spin" />
										Loading...
									{:else}
										<Download class="w-3.5 h-3.5" />
										Populate
									{/if}
								</Button>
								<Tooltip.Root>
									<Tooltip.Trigger>
										<HelpCircle class="w-3.5 h-3.5 text-muted-foreground cursor-help" />
									</Tooltip.Trigger>
									<Tooltip.Content>
										<div class="w-64">
											<p class="text-xs">Clone the repository and load environment variables from the <code class="bg-muted px-1 rounded">.env</code> file (in compose directory) and additional env file (if specified), so you can see what you can override.</p>
										</div>
									</Tooltip.Content>
								</Tooltip.Root>
							</div>
						{/if}
					{/snippet}
				</StackEnvVarsPanel>
			</div>
		</div>

		<Dialog.Footer class="px-5 py-2.5 border-t border-zinc-200 dark:border-zinc-700 flex-shrink-0">
			<Button variant="outline" onclick={onClose}>Cancel</Button>
			{#if gitStack}
				<Button variant="outline" onclick={() => saveGitStack(true)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						Deploying...
					{:else}
						<Rocket class="w-4 h-4" />
						Save and deploy
					{/if}
				</Button>
				<Button onclick={() => saveGitStack(false)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						Saving...
					{:else}
						Save changes
					{/if}
				</Button>
			{:else}
				<Button onclick={() => saveGitStack(formDeployNow)} disabled={formSaving}>
					{#if formSaving}
						<Loader2 class="w-4 h-4 mr-1 animate-spin" />
						{formDeployNow ? 'Deploying...' : 'Creating...'}
					{:else}
						{formDeployNow ? 'Deploy' : 'Create'}
					{/if}
				</Button>
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

<!-- Git repository filesystem browser -->
<!-- Opens when user clicks Browse next to the compose file path field -->
<FilesystemBrowser
	bind:open={showGitRepoBrowser}
	title="Select compose file"
	icon={FolderGit2}
	description="Browse the repository contents and select a compose file"
	selectFilter={/\.ya?ml$/i}
	selectMode="file"
	apiUrl={gitBrowserApiUrl}
	bind:rootPath={gitBrowserRootPath}
	bind:cloningMessage={gitBrowserCloningMessage}
	onSelect={handleGitBrowseSelect}
	onClose={() => {
		showGitRepoBrowser = false;
		gitBrowserCloningMessage = undefined;
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
