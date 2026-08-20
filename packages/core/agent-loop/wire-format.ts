/**
 * 历史 → provider 的**线上字节形态**(F10a,§13.2/§13.4)。
 *
 * 这两个函数原来是 `messages.ts` 的私有实现。搬出来单独放,是因为它们是全仓
 * **唯一**回答"这一格最后以什么字节发出去"的地方,而这个答案有第二个消费者:
 * 影子断言的判等器(`packages/core/session/projection/canonical.ts`)。
 *
 * 为什么判等器非要它不可:工具结局与工具参数在 wire 上是**一整个字符串**
 * (`JSON.stringify` 的输出),而 `JSON.stringify` 保留**键的插入序**。判等器
 * 对对象排序键之后,`{"a":1,"b":2}` 与 `{"b":2,"a":1}` 会被判成同一件事 ——
 * 但它们发出去是两串不同的字节,对 provider 的 prompt cache 就是两段不同的
 * 前缀。这是全表唯一"判等但不等价"的格。
 *
 * **一份实现,两个消费者**:抄一份到判等器里等于给自己埋一个"哪天 wire 改了
 * 而判据没跟上"的洞。入参放宽到 `unknown` 也是为了这个 —— 判据拿到的是投影
 * 出来的裸对象,不该为了过类型再复制一遍形状声明。
 */

/** 工具结局的 wire 形态:字符串原样,其余 `JSON.stringify`(键序敏感)。 */
export function stringifyToolResult(result: unknown): string {
	if (result == null) return "";
	if (typeof result === "string") return result;
	try {
		return JSON.stringify(result);
	} catch {
		return String(result);
	}
}

/** 工具参数的 wire 形态:已经是字符串就原样,否则 `JSON.stringify(args ?? {})`。 */
export function toolCallArguments(call: {
	arguments?: unknown;
	args?: unknown;
}): string {
	if (typeof call.arguments === "string") return call.arguments;
	try {
		return JSON.stringify(call.args ?? {});
	} catch {
		return "{}";
	}
}
