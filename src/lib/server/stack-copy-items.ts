import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

export function copyStackItems(paths: string[], destination: string): void {
	const target = resolve(destination);
	for (const path of paths) {
		if (!isAbsolute(path) || path === '/') throw new Error('Select absolute file or directory paths');
		const source = resolve(path);
		const rel = relative(source, target);
		if (source === target || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Cannot copy a directory into itself');
		const sourceUnderDestination = relative(target, source);
		if (!sourceUnderDestination.startsWith('..') && !isAbsolute(sourceUnderDestination)) throw new Error('Item is already inside the destination');
		const check = (item: string) => {
			const stat = lstatSync(item);
			if (stat.isSymbolicLink()) throw new Error(`Cannot copy a symbolic link: ${item}`);
			if (stat.isDirectory()) for (const entry of readdirSync(item)) check(join(item, entry));
			else if (!stat.isFile()) throw new Error(`Not a regular file: ${item}`);
		};
		check(source);
		const output = join(target, basename(source));
		for (let item = output; item !== target; item = resolve(item, '..')) {
			if (existsSync(item) && lstatSync(item).isSymbolicLink()) throw new Error(`Cannot copy onto a symbolic link: ${item}`);
		}
		const checkDestination = (item: string) => {
			if (!existsSync(item)) return;
			const stat = lstatSync(item);
			if (stat.isSymbolicLink()) throw new Error(`Cannot copy onto a symbolic link: ${item}`);
			if (stat.isDirectory()) for (const entry of readdirSync(item)) checkDestination(join(item, entry));
		};
		checkDestination(output);
		mkdirSync(target, { recursive: true });
		cpSync(source, output, { recursive: true, force: true });
	}
}
