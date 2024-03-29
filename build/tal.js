(function () {
	'use strict';

	const
		isArray = val => Array.isArray(val),
		isDefined = val => undefined !== val,
		isFunction = val => typeof val === "function",
		isObject = val => typeof val === "object",
		nullObject = () => Object.create(null),

		popAttribute = (el, name) =>
		{
			const value = el.getAttribute(name);
			el.removeAttribute(name);
			value && ((el.TAL || (el.TAL = {})).name = value);
			return value;
		};

	class TalError extends Error {}

	class ObservablesMap extends WeakMap {
		get(obj) {
			return obj[OBSERVABLE] ? obj : super.get(obj);
		}
	}

	class Observers extends Map {

		observe(property, callback, event) {
			if ("beforeChange" === event) {
				// To observe old value
				property = property + ".beforeChange";
			}
			this.has(property) || this.set(property, new Set);
			this.get(property).add(callback);
		}

		unobserve(property, callback, event) {
			if ("beforeChange" === event) {
				// To unobserve old value
				property = property + ".beforeChange";
			}
			this.has(property) && this.get(property).delete(callback);
		}

		dispatch(property, value) {
			return dispatch(this.get(property), property, value);
		}

		dispatchAll(obj) {
			this.forEach((callbacks, prop) => dispatch(callbacks, prop, obj[prop]));
			// Refresh children, does not work
	//		Object.values(obj).forEach(value => value && value.refreshObservers && value.refreshObservers());
		}
	}

	let detectingObservables;

	const
		OBSERVABLE = Symbol("observable"),

		isContextProp = prop => contextProps.includes(prop),

		isObservable = obj => obj && obj[OBSERVABLE],

		detectObservables = () => {
			detectingObservables || (detectingObservables = []);
		},

		getDetectedObservables = () => {
			let result = detectingObservables;
			detectingObservables = null;
			return result;
		},

		observablesMap = new ObservablesMap(),

		// Vue trigger
		dispatch = (callbacks, prop, value) => {
			callbacks && callbacks.forEach(cb => {
				try {
					cb(value, prop);
				} catch (e) {
					console.error(e, {
						prop: prop,
						value: value,
						callback:cb
					});
				}
			});
			return true;
		},

		contextGetter = (observable, target, prop, observers, parent) => {
			switch (prop)
			{
				case OBSERVABLE: return 1;
				// Vue watch(), Knockout subscribe()
				case "observe":
				case "unobserve":
					return observers[prop].bind(observers);
				case "clearObservers":
					return () => observers.clear();
				case "observers":
					return observers;
				case "refreshObservers":
					return () => observers.dispatchAll(target);
				// Vue computed(), Knockout computed()
				case "defineComputed":
					return (name, callable) => {
						detectObservables();
						callable();
						getDetectedObservables().forEach(([obj, prop]) => obj.observe(prop, callable));
						Object.defineProperty(target, name, { get: callable });
					};
				/**
				 * TAL built-in Names
				 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#built-in-names
				 */
				case "context":
					return observable;
				case "parent":
					return parent;
				case "root":
					return parent ? parent[prop] : observable;
	//				return (parent && parent[OBSERVABLE]) ? parent[prop] : observable;
			}
		};

	const contextProps = [
			OBSERVABLE,
			"observe",
			"unobserve",
			"clearObservers",
			"observers",
			"refreshObservers",
			"defineComputed",
			// TAL
			"context",
			"parent",
			"root"
		];

	function observeObject(obj, parent/*, deep*/)
	{
		if (!isObject(obj)) {
			return obj;
		}

		let observable = observablesMap.get(obj);
		if (!observable) {
	/*
			// If deep doesn't evaluate to true, only a shallow proxy is created
			if (deep) {
				Object.entries(properties).forEach(([key,value]) => {
					if (isObject(value)) {
						if (isArray(value)) {
							// Observe the array
						} else {
							// Observe the object
						}
					}
					this[key] = value
				});
		}
	*/
			if (!parent) {
				parent = null;
			} else if (!parent[OBSERVABLE]) {
				console.dir({parent});
				throw new TalError('parent is not observable');
			}
			const observers = new Observers;
			observable = new Proxy(obj, {
				get(target, prop, receiver) {
					let result = contextGetter(observable, target, prop, observers, parent);
					if (!isDefined(result)) {
						if (Reflect.has(target, prop)) {
							result = Reflect.get(target, prop, receiver);
							if (isFunction(result) && !result[OBSERVABLE]) {
								return (...args) => result.apply(target, args);
	//							return (...args) => result.apply(observable, args);
							}
							detectingObservables?.push([observable, prop]);
						} else if (typeof prop !== 'symbol') {
							if (parent) {
	//							console.log(`Undefined property '${prop}' in current observeObject, lookup parent`, {target,parent});
								result = parent[prop];
							} else {
								console.error(`Undefined property '${prop}' in current observeObject`, {target,parent});
							}
						}
					}
					return result;
				},
				has(target, prop) {
					return isContextProp(prop) || Reflect.has(target, prop);
					// || (parent && prop in parent)
				},
				set(target, prop, value, receiver) {
					let result = true;
					if (!detectingObservables) {
						if (isContextProp(prop)) {
							throw new TalError(`${prop} can't be initialized, it is internal`);
						}
						let oldValue = Reflect.get(target, prop, receiver);
						if (oldValue !== value) {
							observers.dispatch(prop + ".beforeChange", oldValue);
							result = Reflect.set(target, prop, value, receiver);
							value = Reflect.get(target, prop, receiver);
							if (result && oldValue !== value) {
								observers.dispatch(prop, value);
							}
						}
					}
					return result;
				},
				deleteProperty(target, prop) {
					Reflect.has(target, prop) && observers.delete(prop);
					return Reflect.deleteProperty(target, prop);
				}
			});
			observablesMap.set(obj, observable);
		}
		return observable;
	}

	/**
	 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-overview
	 */
	class Tales
	{
		static resolve(expr, context, writer) {
			let match = expr.trim().match(/^([a-z]+):(.+)/);
			if (match && Tales[match[1]]) {
				return Tales[match[1]](expr, context, writer);
			}
			return Tales.path(expr, context, writer) || Tales.string(expr);
		}

		/**
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-string-expressions
		 */
		static string(expr) {
			expr = expr.trim().match(/^(?:'([^']*)'|"([^"]*)"|string:(.*))$/) || [];
			expr[0] = null;
			return expr.find(str => null != str);
		}

		/**
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-not-expressions
		 */
		static not(expr, context) {
			let match = expr.trim().match(/^not:(.+)$/);
			if (match) {
				let fn = Tales.resolve(match[1], context);
				let not = () => !fn();
				not.talesContext = fn.talesContext;
				not.talesProp = fn.talesProp;
				return not;
			}
		}

		/**
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-exists-expressions
		 */
		static exists(expr, context) {
			let match = expr.trim().match(/^(?:exists:)?([a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_]*)*)$/);
			if (match) {
				if (!isObservable(context)) {
					throw new TalError(`context '${expr}' can't be observed`);
				}
				match = match[1].trim().split("/");
				let i = 0, l = match.length;
				for (; i < l; ++i) {
					if (!(match[i] in context)) {
						return false;
					}
					context = context[match[i]];
				}
				return !!context;
			}
			return false;
		}

		/**
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-path-expressions
		 */
		static path(expr, context, writer) {
			let match = expr.trim().match(/^(?:path:)?([a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_]*)*)$/);
			if (match) {
				if (!isObservable(context)) {
					throw new TalError(`context '${expr}' can't be observed`);
				}
				match = match[1].trim().split("/");
				let i = 0, l = match.length - 1;
				for (; i < l; ++i) {
					if (!(match[i] in context)) {
						console.error(`Path '${expr}' part ${i} not found`, context);
						return;
					}
					let newContext = context[match[i]];
					if (!isObservable(newContext)) {
						newContext = observeObject(newContext, context);
						try {
							context[match[i]] = newContext;
						} catch (e) {
							console.error(e,{context, prop:match[i]});
						}
					}
					context = newContext;
				}
				let fn = context[match[l]];
				if (!isFunction(fn)) {
					fn = (writer ? value => context[match[l]] = value : () => context[match[l]]);
				}
				let path = (...args) => {
					try {
						return fn.apply(context, args);
					} catch (e) {
						console.error(e, {expr, context});
					}
				};
				path.talesContext = context;
				path.talesProp = match[l];
	//			path.fnBody = path.toString();
				return path;
			}
		}

		/**
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#tales-nocall-expressions
		 */
		static nocall(expr) {
			let match = expr.trim().match(/^(?:nocall:)?([a-zA-Z][a-zA-Z0-9_]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_]*)*)$/);
			if (match) {
				throw new TalError(`Tales nocall: is not supported`);
			}
		}

		static js(expr, context) {
			let match = expr.trim().match(/^js:(.+)$/);
			if (match) try {
				let fn = new Function(`with(this){return ${match[1]}}`),
					js = () => {
						try {
							return fn.apply(context);
						} catch (e) {
							console.error(e, {expr, context});
						}
					};
				js.talesContext = context;
				return js;
			} catch (e) {
				console.error(e, {expr, context});
			}
		}
	}

	function observeArray(obj, parent/*, deep*/)
	{
	//	if (!isArray(obj) && !(obj instanceof Set) && !(obj instanceof Map)) {
		if (!isArray(obj)) {
			throw new TalError("Not an Array");
		}
		let observable = observablesMap.get(obj);
		if (!observable) {
			obj = observeObject(obj, parent);
			const observers = obj.observers;
			observable = new Proxy(obj, {
				get(target, prop, receiver) {
					switch (prop)
					{
					// Set
					case "clear":
						return () => {
							observers.dispatch(prop);
							return target.clear();
						};
					case "add":
					case "delete":
						throw new TalError("Set.prototype."+prop+"() not supported");
					// Array mutator methods
					case "copyWithin":
					case "fill":
					case "reverse":
					case "sort":
						throw new TalError("Array.prototype."+prop+"() not supported");
					case "shift":
					case "pop":
						return () => {
							observers.dispatch(prop+".beforeChange");
							let value = target[prop]();
							observers.dispatch(prop, value);
							return value;
						};
					case "unshift":
					case "splice":
					case "push":
						return (...args) => {
							args = args.map(target => observeObject(target, observable));
							let result = target[prop](...args);
							observers.dispatch(prop, args);
							return result;
						};
					}
					return Reflect.get(target, prop, receiver);
				},
				set(target, prop, value, receiver) {
					let result = true;
					if (!detectingObservables) {
						if (isFinite(prop)) {
							value = observeObject(value, observable);
							let oldValue = Reflect.get(target, prop, receiver);
							if (oldValue !== value) {
								result = Reflect.set(target, prop, value, receiver);
								value = Reflect.get(target, prop, receiver);
								if (result && oldValue !== value) {
									observers.dispatch("set", {index:prop, value});
								}
							}
						} else {
							observers.dispatch(prop, value);
						}
					}
					return result;
				}
			});

			obj.forEach((item, index) => obj[index] = observeObject(item, observable));

			observablesMap.set(obj, observable);
		}
		return observable;
	}

	function observeFunction(fn, parent)
	{
		if (!isFunction(fn)) {
			throw new TalError("Not a Function");
		}
		let observable = observablesMap.get(fn);
		if (!observable) {
			if (!parent) {
				parent = null;
			} else if (!parent[OBSERVABLE]) {
				console.dir({parent});
				throw new TalError('parent is not observable');
			}
			const observers = new Observers;
			observable = new Proxy(fn, {
				get(target, prop, receiver) {
					if (isContextProp(prop)) {
						return contextGetter(observable, target, prop, observers, parent);
					}
					return Reflect.get(target, prop, receiver);
				},
				has(target, prop) {
					return isContextProp(prop) || Reflect.has(target, prop);
					// || (parent && prop in parent)
				},
				set(target, prop, value, receiver) {
					if (detectingObservables) {
						return true;
					}
					if (isContextProp(prop)) {
						throw new TalError(`${prop} can't be initialized, it is internal`);
					}
					let oldValue = Reflect.get(target, prop, receiver),
						result = Reflect.set(target, prop, value, receiver);
					value = Reflect.get(target, prop, receiver);
					if (result && oldValue !== value) {
						observers.dispatch(prop, value);
					}
					return result;
				},
				apply(target, thisArg, argumentsList) {
					return Reflect.apply(target, thisArg, argumentsList);
				},
				deleteProperty(target, prop) {
					Reflect.has(target, prop) && observers.delete(prop);
				}
			});
			observablesMap.set(fn, observable);
		}
		return observable;
	}

	function observeType(item, parent/*, deep*/)
	{
		let type = (null != item) ? typeof item : "null";
		switch (type)
		{
		// primitives
		case "undefined":
		case "null":
		case "bigint":
		case "boolean":
		case "number":
		case "string":
		case "symbol":
			return item;
	//		return observePrimitive(item, parent/*, deep*/);
		}

		let observable = observablesMap.get(item);
		if (observable) {
			return observable;
		}

		if ("function" === type) {
			observable = observeFunction(item, parent/*, deep*/);
		} else if (isArray(item)) {
			observable = observeArray(item, parent/*, deep*/);
		} else if ("object" === type) {
			observable = observeObject(item, parent/*, deep*/);
		}

		observablesMap.set(item, observable);

		return observable;
	}

	/**
	 * Used for garbage collection as Mutation Observers are not reliable
	 */
	const
		observables = Symbol("observables"),
		observe = (el, obj, prop, cb) =>
		{
			obj.observe(prop, cb);
			el[observables] || (el[observables] = new Set);
			el[observables].add(()=>obj.unobserve(prop, cb));
		},
		regexKeyExpression = /^([^\s]+)\s+(.+)$/,
		regexTextStructure = /^(?:(text|structure)\s+)?(.*)$/,
		regexLocalGlobal   = /^(?:(local|global)\s+)?([^\s]+)\s+(.+)$/,
		removeNode = node => {
			if (node) {
				node[observables]?.forEach?.(cb => cb());
				delete node[observables];
				[...node.childNodes].forEach(removeNode);
				node.remove();
			}
		},
		resolveTales = (expression, context, writer) => Tales.resolve(expression, context, writer),
		getterValue = getter => isFunction(getter) ? getter() : getter,
		processDetectedObservables = (el, fn) =>
			getDetectedObservables().forEach(([obj, prop]) =>
				observe(el, obj, prop, fn)
			);

	class Statements
	{
		/**
		 * tal:attributes - dynamically change element attributes.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#attributes-replace-element-attributes
		 */
		static attributes(el, value, context) {
	//		value.matchAll(/([^\s;]+)\s+([^;]+)/);
			value.split(";").forEach(attr => {
				attr = attr.trim().match(regexKeyExpression);
				let text, getter = resolveTales(attr[2], context);
				if (isDefined(getter)) {
					detectObservables();
					text = getterValue(getter);
					processDetectedObservables(el, value => {
						value = getterValue(getter);
						if (false === value || null == value) {
							el.removeAttribute(attr[1], value);
						} else {
							el.setAttribute(attr[1], value);
						}
						el[attr[1]] = value;
					});
				}
				if (false === text || null == text) {
					el.removeAttribute(attr[1], text);
				} else {
					el.setAttribute(attr[1], text);
				}
			});
		}

		/**
		 * tal:content - replace the content of an element.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#content-replace-the-content-of-an-element
		 */
		static content(el, value, context) {
			let match = value.trim().match(regexTextStructure),
				expression = match[2],
				getter = resolveTales(expression, context),
				mode = "structure" === match[1] ? "innerHTML" : "textContent";
			if (isDefined(getter)) {
				detectObservables();
				el[mode] = getterValue(getter);
				processDetectedObservables(el, () => el[mode] = getterValue(getter));
			}
		}

		/**
		 * tal:replace - replace the content of an element and remove the element leaving the content.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#replace-replace-an-element
		 */
		static replace(el, value, context) {
			let match = value.trim().match(regexTextStructure),
				expression = match[2],
				text, getter = resolveTales(expression, context),
				fn;
			if (isFunction(getter)) {
				let node = el.ownerDocument.createTextNode("");
				el.replaceWith(node);
				if ("structure" === match[1]) {
					// Because the Element is replaced, it is gone
					// So we prepend an empty TextNode as reference
					let frag;
					// Now we can put/replace the HTML after the empty TextNode
					fn = string => {
						frag && frag.forEach(el => el.remove());
						const template = document.createElement("template");
						template.innerHTML = string.trim();
						frag = Array.from(template.content.childNodes);
						node.after(template.content);
					};
				} else {
					fn = string => node.nodeValue = string;
				}
				detectObservables();
				text = getterValue(getter);
				processDetectedObservables(el, () => fn(getterValue(getter)));
			} else {
				text = getterValue(getter);
				if ("structure" === match[1]) {
					fn = string => el.outerHTML = string;
				} else {
					fn = string => el.replaceWith(string);
				}
			}
			fn(text);
		}

		/**
		 * tal:define - define variables.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#define-define-variables
		 */
		static define(el, expression, context) {
			expression.split(";").forEach(def => {
				def = def.trim().match(regexLocalGlobal);
				let prop = def[2],
					expression = def[3],
					getter = resolveTales(expression, context),
					text = getterValue(getter);
				if ("global" === def[1]) {
					let root = context.root;
					if (prop in root && isFunction(root[prop])) {
						root[prop](text, el);
					} else {
						root[prop] = text;
					}
				} else if (prop in context && isFunction(context[prop])) {
					context[prop](text, el);
				} else {
					context[prop] = text;
				}
			});
		}

		/**
		 * tal:condition - test conditions.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#condition-conditionally-insert-or-remove-an-element
		 */
		static condition(el, expression, context, parser) {
			let target = el.ownerDocument.createTextNode(""),
				text, getter = resolveTales(expression, context),
				node, fn = value => {
					node && removeNode(node);
					if (value) {
						node = el.cloneNode(true);
						parser(node, context);
						target.after(node);
					}
				};
			el.replaceWith(target);
			if (isDefined(getter)) {
				detectObservables();
				text = getterValue(getter);
				processDetectedObservables(el, () => fn(getterValue(getter)));
			}
			fn(text);
			return {
				hasChild: node => el.contains(node)
			}
		}

		/**
		 * tal:repeat - repeat an element.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#repeat-repeat-an-element
		 * This is very complex as it creates a deeper context
		 * Especially when there"s a repeat inside a repeat, like:
		 * <div tal:repeat="item context/cart">
		 *     <div tal:repeat="prop item/props">
		 *         <input tal:attributes="name "item[${item/id}][${prop/id}]""/>
		 *     </div>
		 * </div>
		 */
		static repeat(el, expression, context, parser) {
			const match = expression.trim().match(regexKeyExpression),
				items = [],
				target = el.ownerDocument.createTextNode(""),
				createItem = value => {
					let node = el.cloneNode(true), subContext;
					try {
						value = observeType(value, context);
					} catch (e) {
						console.error(e);
					}
					if ('$data' == match[1] && isObservable(value)) {
						subContext = value;
					} else {
						subContext = observeObject(nullObject(), context);
						subContext[match[1]] = value;
					}
					parser(node, subContext);
					return node;
				};

			items.name = match[1];
			items.hasChild = node => el.contains(node);
			items.add = (value, pos) => {
				let node = createItem(value);
				if (isFinite(pos) && pos < items.length) {
					if (0 == pos) {
						items[0].before(node);
						items.unshift(node);
					} else {
						items[pos].before(node);
						items.splice(pos, 0, node);
					}
				} else {
					target.before(node);
	//				items.length ? items[items.length-1].after(node) : items.parent.insertBefore(node, target);
					items.push(node);
				}
			};

			el.replaceWith(target);

			let getter = resolveTales(match[2], context);
			let array = getterValue(getter);
			if (array) {
				if (!isObservable(array) && getter.talesProp) {
	//				if (!isArray(array)) {
					array = observeArray(array, context);
					getter.talesContext[getter.talesProp] = array;
				}
				observe(el, array, "clear", () => {
					items.forEach(removeNode);
					items.length = 0;
				});
				observe(el, array, "pop.beforeChange", () => removeNode(items.pop()));
				observe(el, array, "shift.beforeChange", () => removeNode(items.shift()));
				observe(el, array, "unshift", (args) => {
					let i = args.length;
					while (i--) items.add(args[i], 0);
				});
				observe(el, array, "splice", (args) => {
					let i;
					if (0 < args[1]) {
						i = Math.min(items.length, args[0] + args[1]);
						while (args[0] < i--) removeNode(items[i]);
						items.splice(args[0], args[1]);
					}
					for (i = 2; i < args.length; ++i) {
						items.add(args[i], args[0]);
					}
				});
				observe(el, array, "push", (args) => args.forEach(item => items.add(item)));
				observe(el, array, "length", length => {
					while (items.length > length) removeNode(items.pop());
				});
				observe(el, array, "set", item => {
					if (item.index in items) {
						let node = createItem(item.value);
						items[item.index].replaceWith(node);
						items[item.index] = node;
					} else {
						items.add(item.value, item.index);
					}
				});
				observe(el, observable, "value", array => {
					while (items.length > 0) removeNode(items.pop());
					array.forEach((value, pos) => items.add(value, pos));
				});

				// Fill the list with current repeat values
				array.forEach((value, pos) => items.add(value, pos));
			} else {
				console.error(`Path '${match[2]}' for repeat not found`, context);
			}

			return items;
		}

		/**
		 * tal:omit-tag - remove an element, leaving the content of the element.
		 * https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#omit-tag-remove-an-element-leaving-its-contents
		 */
		static ["omit-tag"](el, expression, context) {
			if (expression) {
				let getter = resolveTales(expression, context);
				if (isDefined(getter)) {
	//				detectObservables();
					expression = getterValue(getter);
	//				processDetectedObservables(el, () => fn(getterValue(getter)));
				}
			} else {
				expression = true;
			}
			if (expression) {
				el.replaceWith(...el.childNodes);
			}
		}

	/*
		tal:switch - define a switch condition
		tal:case - include element only if expression is equal to parent switch

		static ["on-error"](el, expression, context) {
			Statements.content(el, expression, context);
		}
	*/

		/**
		 * tal:listen - Observe native elements using addEventListener for two-way bindings
		 * like: HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLDetailsElement
		 */
		static listen(el, value, context) {
			if (el.addEventListener) {
	//			value.matchAll(/([^\s;]+)\s+([^;]+)/);
				value.split(";").forEach(attr => {
					if (attr = attr.trim().match(regexKeyExpression)) {
						const setter = resolveTales(attr[2], context, true);
						if (setter) {
							if ("value" === attr[1] || "checked" === attr[1]) {
								el.addEventListener("change", () => setter(el[attr[1]]));
							} else if ("input" === attr[1]) {
								el.addEventListener(attr[1], () => setter(el.value));
							} else if ("toggle" === attr[1]) {
								el.addEventListener(attr[1], event => setter(event.newState));
							} else {
								el.addEventListener(attr[1], setter);
							}
						}
					}
				});
			}
		}

		static with(el, expression, context, parser) {
			let target = el.ownerDocument.createTextNode(""),
				text, getter = resolveTales(expression, context),
				node, fn = value => {
					node && removeNode(node);
					if (value) {
						node = el.cloneNode(true);
						parser(node, value);
						target.after(node);
					}
				};
			el.replaceWith(target);
			if (getter) {
				detectObservables();
				getterValue(getter);
				processDetectedObservables(el, () => fn(getterValue(getter)));
			}
			fn(text);
			return {
				hasChild: node => el.contains(node)
			}
		}
	}

	Statements.methods = Object.getOwnPropertyNames(Statements).filter(n => isFunction(Statements[n]));
	Statements.cssQuery = "[tal\\:" + Statements.methods.join("],[tal\\:") + "]";
	//Statements.cssQuery = "[data-tal-" + Statements.methods.join("],[data-tal-") + "]";

	// context = observeObject(obj)
	// TalContext
	function parse(template, context)
	{
		if (typeof template === "string") {
			template = document.getElementById(template);
		}
		if (!(template instanceof Element)) {
			throw new TalError("template not an instance of Element");
		}
		if (!isObservable(context)) {
			throw new TalError("context is not observed");
		}
	//	context = observeObject(context);

		parse.converters.forEach(fn => fn(template, context));

		let skippers = [];
		// querySelectorAll result is a static (not live) NodeList
		// Using a live list we should use template.children
		(template instanceof HTMLTemplateElement
			? template.content.querySelectorAll(Statements.cssQuery)
			// template root node must be prepended as well
			: [template, ...template.querySelectorAll(Statements.cssQuery)]
		).forEach(el => {
			if (skippers.some(parent => parent.hasChild(el))) {
				// Skip this element as it is handled by Statements.repeat or Statements.condition
				return;
			}

			let value = popAttribute(el, "tal:define");
			if (null != value) {
				Statements.define(el, value, context);
			}

	/*
			let value = popAttribute(el, "tal:switch");
			if (null != value) {
				Statements.switch(el, value, context);
			}
	*/

			value = popAttribute(el, "tal:with");
			if (null != value) {
				skippers.push(Statements.with(el, value, context, parse));
			} else if (null != (value = popAttribute(el, "tal:condition"))) {
				skippers.push(Statements.condition(el, value, context, parse));
			}

			value = popAttribute(el, "tal:repeat");
			if (null != value) {
				skippers.push(Statements.repeat(el, value, context, parse));
				return;
			}

	/*
			let value = popAttribute(el, "tal:case");
			if (null != value) {
				Statements.case(el, value, context);
			}
	*/

			value = popAttribute(el, "tal:content");
			if (null != value) {
				Statements.content(el, value, context);
			} else if (null != (value = popAttribute(el, "tal:replace"))) {
				Statements.replace(el, value, context);
				return;
			}

			value = popAttribute(el, "tal:attributes");
			if (null != value) {
				Statements.attributes(el, value, context);
			}

			if (el.hasAttribute("tal:omit-tag")) {
				Statements["omit-tag"](el, popAttribute(el, "tal:omit-tag"), context);
			}

			// Our two-way bindings
			value = popAttribute(el, "tal:listen");
			if (null != value) {
				Statements.listen(el, value, context);
			}

	/*
			https://zope.readthedocs.io/en/latest/zopebook/AppendixC.html#on-error-handle-errors
			let value = popAttribute(el, "tal:on-error");
			if (null != value) {
				Statements["on-error"](el, value, context);
			}
	*/

			el.getAttributeNames().forEach(name => name.startsWith("tal:") && el.removeAttribute(name));
		});
		return context;
	}

	parse.converters = [
		// Convert KnockoutJS data-bind
	// 	koConvertBindings
	];

	function observePrimitive(prim, parent/*, deep*/)
	{
		if (null != prim && prim[OBSERVABLE]) {
			return prim;
		}

		if (!["string","number","boolean","bigint"].includes(typeof prim)
		 	&& null !== prim
	//	 	&& isDefined(prim)
	//	 	&& !(prim instanceof String)
	//		&& !(prim instanceof Number)
	//		&& !(prim instanceof Boolean)
	//		&& !(prim instanceof BigInt)
		) {
			throw new TalError("Not a primitive");
		}

		if (!parent) {
			parent = null;
		} else if (!parent[OBSERVABLE]) {
			console.dir({parent});
			throw new TalError("parent is not observable");
		}

		let value = prim;
		const observers = new Observers;
		const primitive = () => {};
		const observable = new Proxy(primitive, {
			get(target, prop, receiver) {
				let primitiveGet = contextGetter(observable, target, prop, observers, parent);
				if (!isDefined(primitiveGet)) {
					primitiveGet = Reflect.has(target, prop) ? Reflect.get(target, prop, receiver) : value?.[prop];
					if (isFunction(primitiveGet) && !primitiveGet[OBSERVABLE]) {
						return (...args) => primitiveGet.apply(target, args);
					}
				}
				return primitiveGet;
			},
			has(target, prop) {
				return isContextProp(prop) || Reflect.has(target, prop) || Reflect.has(value, prop);
				// || (parent && prop in parent)
			},
			set(target, prop, value, receiver) {
				if (isContextProp(prop)) {
					throw new TalError(`${prop} can't be initialized, it is internal`);
				}
				return Reflect.set(target, prop, value, receiver);
			},
			apply(target, thisArg, args) {
				if (args.length) {
					if (!detectingObservables && value != args[0]) {
						observers.dispatch("value.beforeChange", value);
						value = args[0];
						observers.dispatch("value", value);
					}
					return observable;
				}
				detectingObservables?.push([observable, "value"]);
				return value;
			},
			deleteProperty(target, prop) {
				Reflect.has(target, prop) && observers.delete(prop);
			}
		});

		return observable;
	}

	/*
	 * When one of the properties inside the getter function is changed
	 * This property must call dispatch(observers[property], property, target[property])
	class computedProperty
	{
		constructor(getterOrOptions) {
			if (isFunction(getterOrOptions)) {
				getterOrOptions = {
					get: getterOrOptions,
					set: () => {console.warn('computedProperty is readonly')}
				}
			}
			this._setter = getterOrOptions.set;
			this._dirty = true;
			this.__v_isRef = true;
			this.effect = effect(getterOrOptions.get, {
				lazy: true,
				scheduler: () => {
					if (!this._dirty) {
						this._dirty = true;
						trigger(toRaw(this), "set", "value");
					}
				}
			});
		}
		get value() {
			const self = toRaw(this);
			if (self._dirty) {
				self._value = this.effect();
				self._dirty = false;
			}
			track(self, "get", "value");
			return self._value;
		}
		set value(newValue) {
			this._setter(newValue);
		}
	}

	function defineComputedProperty(obj, prop, fn, observables)
	{
		observeObject(obj).defineComputed(prop, fn, observables);
	}
	*/

	window.TAL = {
		parse,
		observe: observeType,
		observeObject,
		observeArray,
		observeFunction,
		observePrimitive,
	//	observeProperty,
		TalError,
		TALES: Tales,
		detectObservables,
		getDetectedObservables
	};

})();
