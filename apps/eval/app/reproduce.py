"""Promotion of personal errors: is the candidate expression a valid typical error?

ok = expression inside the allowlist AND reproduces the student's answer in its instance
AND it is distinguishable from the correct answer and from the recipe's errors on `samples` new instances.
"""

import random
from typing import Any

import sympy
from sympy import Symbol

from app.recipes import (
    RecipeError,
    _parse_user,
    _same,
    check_expression,
    evaluate,
    generate,
    parse_recipe,
    serialize,
)

_PARAM_KIND = {"int": "number", "matrix": "matrix", "vector": "vector"}


def _candidate_value(expr: str, scope: dict[str, Any], payload: dict[str, Any]) -> Any:
    """Value of the candidate over `scope`, in the same form as a student's answer."""
    serialized = serialize(evaluate(expr, scope), payload["answerKind"], payload.get("choices"))
    return _parse_user(serialized, payload)


def _scope(recipe: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Values of an instance's parameters (they arrive serialized) plus its variables."""
    scope: dict[str, Any] = {v: Symbol(v) for v in recipe["variables"]}
    for p in recipe["params"]:
        scope[p["name"]] = _parse_user(
            payload["params"][p["name"]], {"answerKind": _PARAM_KIND[p["kind"]], "variables": []}
        )
    return scope


def reproduce(
    raw_recipe: Any, instance_payload: dict[str, Any], user_input: dict[str, Any], candidate: dict[str, Any], samples: int
) -> dict[str, Any]:
    out: dict[str, Any] = {"ok": False, "reproducesUser": False, "distinguishable": False, "problems": []}
    problems: list[str] = out["problems"]
    expr = candidate["expr"]
    try:
        recipe = parse_recipe(raw_recipe)
        scope = _scope(recipe, instance_payload)
        check_expression(expr, set(scope))
    except (RecipeError, KeyError, TypeError, ValueError, sympy.SympifyError) as e:
        problems.append(f"invalid expression or data: {e}")
        return out

    # 1) Reproduces the student's answer on its instance.
    try:
        got = _parse_user(user_input.get("result"), instance_payload)
        out["reproducesUser"] = _same(_candidate_value(expr, scope, instance_payload), got)
    except (RecipeError, ArithmeticError, TypeError, ValueError, sympy.SympifyError) as e:
        problems.append(f"could not evaluate the candidate on this instance: {e}")
    else:
        if not out["reproducesUser"]:
            problems.append("the candidate does not reproduce the student's answer on its instance")

    # 2) It is distinguishable from the correct answer and from each recipe error on new instances.
    rng = random.Random(0)
    distinguishable = True
    for i in range(samples):
        try:
            inst = generate(recipe, rng)
            value = _candidate_value(expr, _scope(recipe, inst), inst)
        except (RecipeError, ArithmeticError, TypeError, ValueError, sympy.SympifyError) as e:
            problems.append(f"instance {i + 1}: could not evaluate the candidate: {e}")
            distinguishable = False
            break
        for name, other in [("the solution", inst["answer"]), *((f"the error «{k}»", v) for k, v in inst["errors"].items())]:
            if _same(value, _parse_user(other, inst)):
                problems.append(f"instance {i + 1}: the candidate matches {name}")
                distinguishable = False
        if not distinguishable:
            break
    out["distinguishable"] = distinguishable
    out["ok"] = out["reproducesUser"] and distinguishable
    return out
