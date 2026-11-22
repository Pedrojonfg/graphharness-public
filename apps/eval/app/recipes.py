# Ported from graphlearn/apps/eval/app/recipes.py (65b56d6).
"""Exercise recipes written by the AI (ADR 039.4, ratified in 051).

The AI does not write code: it writes a declarative recipe (parameters, constraints,
statement, solution and typical errors as expressions). This module interprets it:

- expressions may only use what the AST allowlist permits (operations,
  numbers, parameters, variables and the functions in ALLOWED_FUNCS): no attributes,
  no import, no dunder, no lambdas;
- numbers are chosen by this code, never by the AI (024);
- grading compares with SymPy (golden rule, 038.10).
"""

from __future__ import annotations

import ast
import random
import re
from typing import Any

import sympy
from sympy import Matrix, Rational, Symbol

RECIPE_EVALUATOR_KEY = "recipe_v1"

NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{0,15}$")
# Placeholders in the statement: [[A]] (the braces are LaTeX: \mathbb{R}, \frac{1}{2}…).
PLACEHOLDER_RE = re.compile(r"\[\[([A-Za-z][A-Za-z0-9]*)\]\]")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
MAX_EXPR_CHARS = 300
MAX_PARAMS = 8
MAX_ERRORS = 6
MAX_MATRIX_DIM = 4
MAX_ABS_PARAM = 50
GENERATE_ATTEMPTS = 64
MAX_CONSTANT = 10**6

# Simplicity of the solution (024): fractions with small denominators and bounded values.
MAX_DENOMINATOR = 100
MAX_ABS_VALUE = 1000
MAX_EXPRESSION_CHARS = 160


def _inv(m: Any) -> Any:
    return m.inv() if isinstance(m, sympy.MatrixBase) else 1 / m


def _transpose(m: Any) -> Any:
    return m.T


def _det(m: Any) -> Any:
    return m.det()


def _trace(m: Any) -> Any:
    return m.trace()


def _rank(m: Any) -> Any:
    return m.rank()


def _dot(a: Any, b: Any) -> Any:
    return Matrix(a).dot(Matrix(b))


def _cross(a: Any, b: Any) -> Any:
    return Matrix(a).cross(Matrix(b))


def _rref(m: Any) -> Any:
    return m.rref()[0]


def _norm2(v: Any) -> Any:
    return sum(x**2 for x in Matrix(v))


def _matrix(*rows: Any) -> Any:
    return Matrix([list(r) if isinstance(r, (list, tuple)) else [r] for r in rows])


def _vector(*xs: Any) -> Any:
    return Matrix(list(xs))


def _identity(n: Any) -> Any:
    return sympy.eye(int(n))


def _row(m: Any, i: Any) -> Any:
    return m.row(int(i))


def _col(m: Any, j: Any) -> Any:
    return m.col(int(j))


def _entry(m: Any, i: Any, j: Any) -> Any:
    return m[int(i), int(j)]


def _derivative(f: Any, x: Any, n: Any = 1) -> Any:
    return sympy.diff(f, x, int(n))


def _integral(f: Any, x: Any, a: Any = None, b: Any = None) -> Any:
    if a is None:
        return sympy.integrate(f, x)
    return sympy.integrate(f, (x, a, b))


def _limit(f: Any, x: Any, a: Any) -> Any:
    return sympy.limit(f, x, a)


def _solve_linear(m: Any, b: Any) -> Any:
    return m.LUsolve(Matrix(b))


def _augment(a: Any, b: Any) -> Any:
    return Matrix(a).row_join(Matrix(b))


def _rows(m: Any) -> Any:
    return sympy.Integer(Matrix(m).rows)


def _cols(m: Any) -> Any:
    return sympy.Integer(Matrix(m).cols)


def _nullity(m: Any) -> Any:
    m = Matrix(m)
    return sympy.Integer(m.cols - m.rank())


def _cases(*args: Any) -> Any:
    """cases(cond1, value1, cond2, value2, …, default_value): the first one whose condition holds."""
    if len(args) < 3 or len(args) % 2 == 0:
        raise RecipeError("cases needs pairs (condition, value) and a default value")
    for cond, value in zip(args[0:-1:2], args[1:-1:2]):
        if bool(cond):
            return value
    return args[-1]


ALLOWED_FUNCS: dict[str, Any] = {
    # Matrices and vectors
    "det": _det,
    "inv": _inv,
    "transpose": _transpose,
    "trace": _trace,
    "rank": _rank,
    "rref": _rref,
    "dot": _dot,
    "cross": _cross,
    "norm2": _norm2,
    "matrix": _matrix,
    "vector": _vector,
    "identity": _identity,
    "row": _row,
    "col": _col,
    "entry": _entry,
    "solve_linear": _solve_linear,
    "augment": _augment,
    "rows": _rows,
    "cols": _cols,
    "nullity": _nullity,
    "cases": _cases,
    # Numbers and expressions
    "sqrt": sympy.sqrt,
    "Abs": sympy.Abs,
    "abs": sympy.Abs,
    "gcd": sympy.gcd,
    "lcm": sympy.lcm,
    "factorial": sympy.factorial,
    "binomial": sympy.binomial,
    "floor": sympy.floor,
    "ceiling": sympy.ceiling,
    "Rational": Rational,
    "frac": Rational,
    "sin": sympy.sin,
    "cos": sympy.cos,
    "tan": sympy.tan,
    "asin": sympy.asin,
    "acos": sympy.acos,
    "atan": sympy.atan,
    "exp": sympy.exp,
    "log": sympy.log,
    "simplify": sympy.simplify,
    "expand": sympy.expand,
    "factor": sympy.factor,
    "diff": _derivative,
    "integrate": _integral,
    "limit": _limit,
    "Min": sympy.Min,
    "Max": sympy.Max,
}

ALLOWED_CONSTS: dict[str, Any] = {"pi": sympy.pi, "E": sympy.E, "oo": sympy.oo, "I": sympy.I}

_ALLOWED_NODES = (
    ast.Expression,
    ast.BinOp,
    ast.UnaryOp,
    ast.BoolOp,
    ast.Compare,
    ast.Call,
    ast.Name,
    ast.Load,
    ast.Constant,
    ast.Tuple,
    ast.List,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.Pow,
    ast.Mod,
    ast.MatMult,
    ast.USub,
    ast.UAdd,
    ast.Not,
    ast.And,
    ast.Or,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
)


class RecipeError(ValueError):
    """The recipe (or an answer) cannot be interpreted safely."""


def check_expression(expr: str, names: set[str]) -> ast.Expression:
    """Parses `expr` and checks the allowlist. Returns the AST ready to compile."""
    if not isinstance(expr, str) or not expr.strip():
        raise RecipeError("empty expression")
    if len(expr) > MAX_EXPR_CHARS:
        raise RecipeError(f"expression longer than {MAX_EXPR_CHARS} characters")
    if "__" in expr:
        raise RecipeError("expression with '__'")
    source = expr.replace("^", "**")
    try:
        tree = ast.parse(source, mode="eval")
    except SyntaxError as e:
        raise RecipeError(f"invalid syntax: {expr}") from e
    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise RecipeError(f"{type(node).__name__} is not allowed in: {expr}")
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise RecipeError(f"only numeric constants are allowed in: {expr}")
            if abs(node.value) > MAX_CONSTANT:
                raise RecipeError(f"constant too large in: {expr}")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in ALLOWED_FUNCS:
                name = node.func.id if isinstance(node.func, ast.Name) else type(node.func).__name__
                raise RecipeError(f"function not allowed: {name}")
            if node.keywords:
                raise RecipeError("named arguments are not allowed")
        if isinstance(node, ast.Name):
            ok = node.id in ALLOWED_FUNCS or node.id in ALLOWED_CONSTS or node.id in names
            if not ok:
                raise RecipeError(f"unknown name: {node.id}")
    return tree


def evaluate(expr: str, values: dict[str, Any]) -> Any:
    tree = check_expression(expr, set(values))
    code = compile(tree, "<recipe>", "eval")
    scope: dict[str, Any] = {"__builtins__": {}}
    scope.update(ALLOWED_FUNCS)
    scope.update(ALLOWED_CONSTS)
    scope.update(values)
    return eval(code, scope)  # noqa: S307 — AST checked against an allowlist


# ---------------------------------------------------------------- recipe shape


def _int(v: Any, what: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise RecipeError(f"{what} must be an integer")
    return v


def parse_recipe(raw: Any) -> dict[str, Any]:
    """Checks the shape of the recipe and normalizes it. Raises RecipeError with the reason."""
    if not isinstance(raw, dict):
        raise RecipeError("the recipe must be an object")
    if raw.get("version") != 1:
        raise RecipeError("version must be 1")
    statement = raw.get("statement")
    if not isinstance(statement, str) or not (10 <= len(statement) <= 1200):
        raise RecipeError("statement: text of 10 to 1200 characters")
    # The AI sometimes over-escapes in the JSON («\\mathbb»): in LaTeX «\\» is a line break.
    statement = re.sub(r"\\\\(?=[A-Za-z{}])", r"\\", statement)

    params_raw = raw.get("params")
    if not isinstance(params_raw, list) or not (1 <= len(params_raw) <= MAX_PARAMS):
        raise RecipeError(f"params: 1 to {MAX_PARAMS}")
    params: list[dict[str, Any]] = []
    names: set[str] = set()
    for p in params_raw:
        if not isinstance(p, dict):
            raise RecipeError("each parameter must be an object")
        name = p.get("name")
        if not isinstance(name, str) or not NAME_RE.match(name) or name in ALLOWED_FUNCS or name in ALLOWED_CONSTS:
            raise RecipeError(f"invalid parameter name: {name}")
        if name in names:
            raise RecipeError(f"repeated parameter: {name}")
        kind = p.get("kind")
        lo = _int(p.get("min"), f"{name}.min")
        hi = _int(p.get("max"), f"{name}.max")
        if not (-MAX_ABS_PARAM <= lo <= hi <= MAX_ABS_PARAM):
            raise RecipeError(f"{name}: range outside [-{MAX_ABS_PARAM}, {MAX_ABS_PARAM}]")
        out = {"name": name, "kind": kind, "min": lo, "max": hi, "nonzero": bool(p.get("nonzero", False))}
        if kind == "int":
            pass
        elif kind == "matrix":
            out["rows"] = _int(p.get("rows"), f"{name}.rows")
            out["cols"] = _int(p.get("cols"), f"{name}.cols")
            if not (1 <= out["rows"] <= MAX_MATRIX_DIM and 1 <= out["cols"] <= MAX_MATRIX_DIM):
                raise RecipeError(f"{name}: matrices up to {MAX_MATRIX_DIM}×{MAX_MATRIX_DIM}")
        elif kind == "vector":
            out["size"] = _int(p.get("size"), f"{name}.size")
            if not (1 <= out["size"] <= MAX_MATRIX_DIM):
                raise RecipeError(f"{name}: vectors up to {MAX_MATRIX_DIM}")
        else:
            raise RecipeError(f"{name}: kind must be int, matrix or vector")
        names.add(name)
        params.append(out)

    variables = raw.get("variables") or []
    if not isinstance(variables, list) or len(variables) > 3:
        raise RecipeError("variables: list of up to 3 names")
    for v in variables:
        if not isinstance(v, str) or not NAME_RE.match(v) or v in names or v in ALLOWED_FUNCS or v in ALLOWED_CONSTS:
            raise RecipeError(f"invalid variable: {v}")
    all_names = names | set(variables)

    constraints = raw.get("constraints") or []
    if not isinstance(constraints, list) or len(constraints) > 8:
        raise RecipeError("constraints: up to 8 expressions")
    for c in constraints:
        check_expression(c, all_names)

    answer = raw.get("answer")
    if not isinstance(answer, dict):
        raise RecipeError("answer must be an object")
    kind = answer.get("kind")
    if kind not in ("number", "expression", "matrix", "vector", "choice"):
        raise RecipeError("answer.kind: number, expression, matrix, vector or choice")
    if kind == "expression" and not variables:
        raise RecipeError("an expression-type answer needs variables")
    check_expression(answer.get("expr"), all_names)
    choices: list[str] = []
    if kind == "choice":
        choices = answer.get("choices") or []
        if (
            not isinstance(choices, list)
            or not (2 <= len(choices) <= 6)
            or not all(isinstance(c, str) and 1 <= len(c) <= 120 for c in choices)
            or len(set(choices)) != len(choices)
        ):
            raise RecipeError("answer.choices: 2 to 6 distinct texts")

    errors_raw = raw.get("errors") or []
    if not isinstance(errors_raw, list) or len(errors_raw) > MAX_ERRORS:
        raise RecipeError(f"errors: up to {MAX_ERRORS}")
    errors: list[dict[str, str]] = []
    keys: set[str] = set()
    for e in errors_raw:
        if not isinstance(e, dict):
            raise RecipeError("each error must be an object")
        key = e.get("key")
        if not isinstance(key, str) or not KEY_RE.match(key) or key in keys:
            raise RecipeError(f"invalid or repeated error key: {key}")
        desc = e.get("description")
        if not isinstance(desc, str) or not (5 <= len(desc) <= 300):
            raise RecipeError(f"{key}: description of 5 to 300 characters")
        check_expression(e.get("expr"), all_names)
        keys.add(key)
        errors.append({"key": key, "description": desc, "expr": e["expr"]})

    for placeholder in re.findall(PLACEHOLDER_RE, statement):
        if placeholder not in names:
            raise RecipeError(f"the statement uses [[{placeholder}]], which is not a parameter")

    return {
        "version": 1,
        "statement": statement,
        "params": params,
        "variables": list(variables),
        "constraints": list(constraints),
        "answer": {"kind": kind, "expr": answer["expr"], **({"choices": list(choices)} if kind == "choice" else {})},
        "errors": errors,
    }


# ---------------------------------------------------------------- values


def _sample_param(p: dict[str, Any], rng: random.Random) -> Any:
    def one() -> int:
        while True:
            v = rng.randint(p["min"], p["max"])
            if not p["nonzero"] or v != 0:
                return v

    if p["kind"] == "int":
        return sympy.Integer(one())
    if p["kind"] == "matrix":
        return Matrix([[one() for _ in range(p["cols"])] for _ in range(p["rows"])])
    return Matrix([one() for _ in range(p["size"])])


def _shape_of(value: Any) -> dict[str, int] | None:
    if isinstance(value, sympy.MatrixBase):
        return {"rows": value.rows, "cols": value.cols}
    return None


def _choice_index(value: Any, n: int) -> int:
    v = sympy.nsimplify(value)
    if not v.is_Integer or not (0 <= int(v) < n):
        raise RecipeError(f"the expression of a choice answer must give an index between 0 and {n - 1}")
    return int(v)


def serialize(value: Any, kind: str, choices: list[str] | None = None) -> Any:
    """SymPy value → JSON form equal to the one the student sends in `userInput.result`."""
    if kind == "choice":
        return choices[_choice_index(value, len(choices))]  # type: ignore[index]
    if kind == "matrix":
        if not isinstance(value, sympy.MatrixBase):
            raise RecipeError("the solution had to be a matrix")
        return [[str(sympy.nsimplify(x)) for x in value.row(i)] for i in range(value.rows)]
    if kind == "vector":
        if isinstance(value, sympy.MatrixBase):
            return [str(sympy.nsimplify(x)) for x in value]
        if isinstance(value, (list, tuple)):
            return [str(sympy.nsimplify(x)) for x in value]
        raise RecipeError("the solution had to be a vector")
    if isinstance(value, (sympy.MatrixBase, list, tuple)):
        raise RecipeError(f"the solution had to be a {kind}, not a matrix")
    return str(sympy.nsimplify(value) if kind == "number" else sympy.simplify(value))


def _is_simple_number(x: Any) -> bool:
    x = sympy.nsimplify(x)
    if not x.is_number or not x.is_finite:
        return False
    if x.is_Rational:
        return abs(x.p) <= MAX_ABS_VALUE * MAX_DENOMINATOR and x.q <= MAX_DENOMINATOR and abs(x) <= MAX_ABS_VALUE
    # Roots, π…: accepted if they are short and bounded.
    try:
        return len(str(x)) <= 40 and abs(complex(x)) <= MAX_ABS_VALUE and x.is_real
    except (TypeError, ValueError):
        return False


def is_simple(value: Any, kind: str) -> bool:
    """Simplicity rule (024) applied to the solution."""
    if kind == "choice":
        return True
    try:
        if kind in ("matrix", "vector"):
            items = list(value) if isinstance(value, sympy.MatrixBase) else list(value)
            return all(_is_simple_number(x) for x in items)
        if kind == "number":
            return _is_simple_number(value)
        s = sympy.simplify(value)
        return s.is_finite is not False and len(str(s)) <= MAX_EXPRESSION_CHARS and not s.has(sympy.zoo, sympy.nan)
    except Exception:
        return False


_PARAM_KIND = {"int": "number", "matrix": "matrix", "vector": "vector"}


def _render_statement(recipe: dict[str, Any], values: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        return sympy.latex(values[m.group(1)])

    text = re.sub(PLACEHOLDER_RE, repl, recipe["statement"])
    # Signs and ones written the way a teacher would: «+ -3» → «- 3», «-1 x» → «-x».
    text = re.sub(r"\+\s*-\s*", "- ", text)
    text = re.sub(r"-\s*-\s*", "+ ", text)
    text = re.sub(r"(?<![\d.])(-?)1\s+(?=[a-zA-Z](?![a-zA-Z]))", r"\1", text)
    return text


def _symbols(recipe: dict[str, Any]) -> dict[str, Any]:
    return {v: Symbol(v) for v in recipe["variables"]}


def generate(recipe: dict[str, Any], rng: random.Random | None = None) -> dict[str, Any]:
    """One instance: numbers chosen by code, solution and value of each typical error."""
    rng = rng or random.Random()
    kind = recipe["answer"]["kind"]
    syms = _symbols(recipe)
    for _ in range(GENERATE_ATTEMPTS):
        values = {p["name"]: _sample_param(p, rng) for p in recipe["params"]}
        scope = {**values, **syms}
        try:
            if not all(bool(evaluate(c, scope)) is True for c in recipe["constraints"]):
                continue
            answer = evaluate(recipe["answer"]["expr"], scope)
        except (ZeroDivisionError, ValueError, TypeError, ArithmeticError, sympy.SympifyError, RecipeError):
            continue
        except Exception:  # noqa: BLE001 — p. ej. NonInvertibleMatrixError
            continue
        if not is_simple(answer, kind):
            continue
        choices = recipe["answer"].get("choices")
        try:
            correct = serialize(answer, kind, choices)
        except RecipeError:
            continue
        distractors: dict[str, Any] = {}
        for e in recipe["errors"]:
            try:
                wrong = serialize(evaluate(e["expr"], scope), kind, choices)
            except Exception:  # noqa: BLE001 — an error that cannot be computed here is not offered
                continue
            if wrong != correct and wrong not in distractors.values():
                distractors[e["key"]] = wrong
        if kind == "choice":
            # Without typical errors, the other options act as distractors.
            for i, c in enumerate(choices):
                if c != correct and c not in distractors.values():
                    distractors.setdefault(f"choice_{i}", c)
        shape = _shape_of(answer) if kind == "matrix" else None
        if kind == "vector":
            shape = {"size": len(correct)}
        return {
            "recipeVersion": 1,
            "statement": _render_statement(recipe, values),
            "params": {p["name"]: serialize(values[p["name"]], _PARAM_KIND[p["kind"]]) for p in recipe["params"]},
            "answerKind": kind,
            "shape": shape,
            "variables": recipe["variables"],
            "choices": recipe["answer"].get("choices"),
            "answer": correct,
            "errors": distractors,
            # Same format as the pilot: the value as is (what goes in userInput.result).
            "mcq": {"correct": correct, "distractors": dict(distractors)},
        }
    raise RecipeError("could not generate an instance that meets the constraints")


# ---------------------------------------------------------------- grading


def _parse_user_scalar(raw: Any, variables: list[str]) -> Any:
    if isinstance(raw, bool):
        raise RecipeError("invalid answer")
    if isinstance(raw, (int, float)):
        return sympy.nsimplify(raw)
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 200:
        raise RecipeError("empty or too long answer")
    text = raw.strip().replace(",", ".").replace("·", "*").replace("−", "-")
    return sympy.sympify(evaluate(text, {v: Symbol(v) for v in variables}))


def _parse_user(result: Any, payload: dict[str, Any]) -> Any:
    kind = payload["answerKind"]
    if kind == "choice":
        choices = payload.get("choices") or []
        if isinstance(result, int) and not isinstance(result, bool) and 0 <= result < len(choices):
            return choices[result]
        if isinstance(result, str) and result in choices:
            return result
        raise RecipeError("invalid option")
    variables = payload.get("variables") or []
    if kind == "matrix":
        if not isinstance(result, list) or not all(isinstance(r, list) for r in result):
            raise RecipeError("a matrix was expected")
        return Matrix([[_parse_user_scalar(x, variables) for x in r] for r in result])
    if kind == "vector":
        if not isinstance(result, list):
            raise RecipeError("a vector was expected")
        return Matrix([_parse_user_scalar(x, variables) for x in result])
    return _parse_user_scalar(result, variables)


def _from_serialized(value: Any, payload: dict[str, Any]) -> Any:
    return _parse_user(value, payload)


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, str) or isinstance(b, str):
        return a == b
    if isinstance(a, sympy.MatrixBase) or isinstance(b, sympy.MatrixBase):
        if not (isinstance(a, sympy.MatrixBase) and isinstance(b, sympy.MatrixBase)) or a.shape != b.shape:
            return False
        return all(sympy.simplify(x - y) == 0 for x, y in zip(a, b))
    return sympy.simplify(a - b) == 0


def grade(payload: dict[str, Any], user_input: dict[str, Any]) -> dict[str, Any]:
    if payload.get("recipeVersion") != 1:
        raise ValueError("invalid_instance_payload")
    try:
        got = _parse_user(user_input.get("result"), payload)
    except Exception:  # noqa: BLE001 — an answer that cannot be understood is incorrect, not a 500
        return {"correct": False, "detectorKey": "unreadable_answer"}
    expected = _from_serialized(payload["answer"], payload)
    if _same(got, expected):
        return {"correct": True}
    for key, value in (payload.get("errors") or {}).items():
        try:
            if _same(got, _from_serialized(value, payload)):
                return {"correct": False, "detectorKey": key}
        except Exception:  # noqa: BLE001
            continue
    return {"correct": False}


class RecipeEvaluator:
    """`recipe_v1` evaluator: the recipe travels in `generationSpec.recipe`."""

    engine = "sympy_recipe"

    def generate(self, generation_spec: dict[str, Any]) -> dict[str, Any]:
        recipe = parse_recipe(generation_spec.get("recipe"))
        return generate(recipe)

    def grade(self, payload: dict[str, Any], user_input: dict[str, Any]) -> dict[str, Any]:
        return grade(payload, user_input)


# ---------------------------------------------------------------- validation (039.4)

VALIDATION_INSTANCES = 200
MIN_CONSTRAINT_RATE = 0.9
MIN_DISTINCT_ANSWERS = 20
MIN_ERROR_DISTINCT_RATE = 0.95
SAMPLES_FOR_CROSS_CHECK = 3


def validate(raw: Any, seed: int = 0) -> dict[str, Any]:
    """Automatic check of 039.4 (points 1–6). Point 7 (contrast with the AI) is done by the worker
    with the `samples` that this returns."""
    problems: list[str] = []
    try:
        recipe = parse_recipe(raw)
    except RecipeError as e:
        return {"ok": False, "problems": [str(e)], "droppedErrors": [], "stats": {}, "samples": [], "recipe": None}

    rng = random.Random(seed)
    instances: list[dict[str, Any]] = []
    failures = 0
    for _ in range(VALIDATION_INSTANCES):
        try:
            instances.append(generate(recipe, rng))
        except RecipeError:
            failures += 1
    rate = len(instances) / VALIDATION_INSTANCES
    if rate < MIN_CONSTRAINT_RATE:
        problems.append(
            f"only {len(instances)} of {VALIDATION_INSTANCES} instances meet the constraints and simplicity (minimum {int(MIN_CONSTRAINT_RATE * 100)} %)"
        )

    distinct = len({str(i["answer"]) for i in instances})
    if recipe["answer"]["kind"] == "choice":
        counts: dict[str, int] = {}
        for i in instances:
            counts[i["answer"]] = counts.get(i["answer"], 0) + 1
        if instances and (len(counts) < 2 or max(counts.values()) / len(instances) > 0.9):
            problems.append("little variety: the same option almost always comes up (none may exceed 90 %)")
    elif instances and distinct < MIN_DISTINCT_ANSWERS:
        problems.append(f"little variety: {distinct} distinct solutions in {len(instances)} instances (minimum {MIN_DISTINCT_ANSWERS})")

    dropped: list[str] = []
    kept_errors = []
    for e in recipe["errors"]:
        hits = sum(1 for i in instances if e["key"] in i["errors"])
        if not instances or hits / len(instances) < MIN_ERROR_DISTINCT_RATE:
            dropped.append(e["key"])
        else:
            kept_errors.append(e)
    recipe = {**recipe, "errors": kept_errors}

    # 6: the grading recognizes itself.
    for inst in instances[:50]:
        if grade(inst, {"result": inst["answer"]}) != {"correct": True}:
            problems.append("the generated solution does not pass when graded")
            break
        for key, value in inst["errors"].items():
            if key in dropped:
                continue
            g = grade(inst, {"result": value})
            if g.get("detectorKey") != key:
                problems.append(f"the error {key} is not recognized when graded")
                break

    samples = [
        {
            "statement": i["statement"],
            "answerKind": i["answerKind"],
            "choices": i.get("choices"),
            "shape": i["shape"],
            "variables": i["variables"],
            "payload": i,
        }
        for i in instances[:SAMPLES_FOR_CROSS_CHECK]
    ]
    return {
        "ok": not problems,
        "problems": problems,
        "droppedErrors": dropped,
        "stats": {"instances": len(instances), "generateFailures": failures, "distinctAnswers": distinct},
        "samples": samples,
        "recipe": recipe if not problems else None,
    }
