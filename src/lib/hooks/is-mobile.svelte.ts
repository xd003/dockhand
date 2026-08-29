import { browser } from '$app/environment';

const DEFAULT_MOBILE_BREAKPOINT = 768;

export class IsMobile {
	#breakpoint: number;
	#current = $state(false);
	#handleMediaChange: ((e: MediaQueryListEvent) => void) | null = null;
	#mql: MediaQueryList | null = null;

	constructor(breakpoint: number = DEFAULT_MOBILE_BREAKPOINT) {
		this.#breakpoint = breakpoint;

		if (browser) {
			this.#mql = window.matchMedia(`(max-width: ${this.#breakpoint - 1}px)`);
			this.#current = this.#mql.matches;
			this.#handleMediaChange = (e: MediaQueryListEvent) => {
				this.#current = e.matches;
			};
			this.#mql.addEventListener('change', this.#handleMediaChange);
		}
	}

	get current() {
		return this.#current;
	}

	destroy() {
		if (this.#mql && this.#handleMediaChange) {
			this.#mql.removeEventListener('change', this.#handleMediaChange);
		}
	}
}
