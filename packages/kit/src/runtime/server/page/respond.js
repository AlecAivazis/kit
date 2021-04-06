import { render_response } from './render.js';
import { load_node } from './load_node.js';
import { respond_with_error } from './respond_with_error.js';

/** @typedef {import('./types.js').Loaded} Loaded */

/**
 * @param {{
 *   request: import('types').Request;
 *   options: import('types.internal').SSRRenderOptions;
 *   $session: any;
 *   route: import('types.internal').SSRPage;
 * }} opts
 * @returns {Promise<import('types').Response>}
 */
export async function respond({ request, options, $session, route }) {
	const match = route.pattern.exec(request.path);
	const params = route.params(match);

	const page = {
		host: request.host,
		path: request.path,
		query: request.query,
		params
	};

	let nodes;

	try {
		nodes = await Promise.all(route.a.map((id) => id && options.load_component(id)));
	} catch (error) {
		return await respond_with_error({
			request,
			options,
			$session,
			status: 500,
			error
		});
	}

	const leaf = nodes[nodes.length - 1].module;

	const page_config = {
		ssr: 'ssr' in leaf ? leaf.ssr : options.ssr,
		router: 'router' in leaf ? leaf.router : options.router,
		hydrate: 'hydrate' in leaf ? leaf.hydrate : options.hydrate
	};

	if (options.only_render_prerenderable_pages && !leaf.prerender) {
		// if the page has `export const prerender = true`, continue,
		// otherwise bail out at this point
		return {
			status: 204,
			headers: {},
			body: null
		};
	}

	/** @type {Loaded[]} */
	let branch;

	ssr: if (page_config.ssr) {
		let context = {};
		branch = [];

		for (let i = 0; i < nodes.length; i += 1) {
			const node = nodes[i];

			/** @type {Loaded} */
			let loaded;

			if (node) {
				/** @type {number} */
				let status;
				/** @type {Error} */
				let error;

				try {
					loaded = await load_node({
						request,
						options,
						route,
						page,
						node,
						$session,
						context,
						is_leaf: i === nodes.length - 1
					});

					if (!loaded) return;

					if (loaded.loaded.redirect) {
						return {
							status: loaded.loaded.status,
							headers: {
								location: loaded.loaded.redirect
							}
						};
					}

					if (loaded.loaded.error) {
						({ status, error } = loaded.loaded);
					}
				} catch (e) {
					status = 500;
					error = e;
				}

				if (error) {
					while (i--) {
						if (route.b[i]) {
							const error_node = await options.load_component(route.b[i]);
							let error_loaded;

							/** @type {Loaded} */
							let node_loaded;
							let j = i;
							while (!(node_loaded = branch[j])) {
								j -= 1;
							}

							try {
								error_loaded = await load_node({
									request,
									options,
									route,
									page,
									node: error_node,
									$session,
									context: node_loaded.context,
									is_leaf: false
								});

								if (error_loaded.loaded.error) {
									continue;
								}

								branch = branch.slice(0, j + 1).concat(error_loaded);
								break ssr;
							} catch (e) {
								continue;
							}
						}
					}

					// TODO backtrack until we find an $error.svelte component
					// that we can use as the leaf node
					// for now just return regular error page
					return await respond_with_error({
						request,
						options,
						$session,
						status,
						error
					});
				}
			}

			branch.push(loaded);

			if (loaded && loaded.loaded.context) {
				// TODO come up with better names for stuff
				context = {
					...context,
					...loaded.loaded.context
				};
			}
		}
	}

	try {
		return await render_response({
			request,
			options,
			$session,
			page_config,
			status: 200,
			error: null,
			branch: branch.filter(Boolean),
			page
		});
	} catch (error) {
		return await respond_with_error({
			request,
			options,
			$session,
			status: 500,
			error
		});
	}
}
