# Ported from graphlearn/apps/eval/tests/test_recipes.py (65b56d6).
import random

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.recipes import RecipeError, check_expression, generate, grade, parse_recipe, validate

INVERSE = {
    "version": 1,
    "statement": "Compute the inverse of the matrix $A = [[A]]$.",
    "params": [{"name": "A", "kind": "matrix", "rows": 2, "cols": 2, "min": -6, "max": 6}],
    "constraints": ["Abs(det(A)) >= 2", "Abs(det(A)) <= 4"],
    "answer": {"kind": "matrix", "expr": "inv(A)"},
    "errors": [
        {"key": "transpose_instead", "description": "Transposes instead of inverting", "expr": "transpose(A)"},
        {"key": "forgot_det", "description": "Forgets to divide by the determinant", "expr": "det(A) * inv(A)"},
        {"key": "always_same", "description": "An error that is not distinguishable from the solution", "expr": "inv(A)"},
    ],
}

DERIVATIVE = {
    "version": 1,
    "statement": "Differentiate $f(x) = [[a]] x^3 + [[b]] x$.",
    "params": [
        {"name": "a", "kind": "int", "min": -9, "max": 9, "nonzero": True},
        {"name": "b", "kind": "int", "min": -9, "max": 9, "nonzero": True},
    ],
    "variables": ["x"],
    "answer": {"kind": "expression", "expr": "diff(a*x^3 + b*x, x)"},
    "errors": [{"key": "power_not_lowered", "description": "Does not lower the exponent", "expr": "3*a*x^3 + b"}],
}


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('x')",
        "A.T",
        "().__class__",
        "(lambda: 1)()",
        "open('x')",
        "1 if A else 2",
        "'hello'",
        "A[0]",
        "det(A, key=1)",
        "10**100000000",
    ],
)
def test_allowlist_rejects(expr):
    with pytest.raises(RecipeError):
        check_expression(expr, {"A"})


def test_valid_inverse_and_discards_errors_that_do_not_distinguish():
    r = validate(INVERSE)
    assert r["ok"], r["problems"]
    assert r["droppedErrors"] == ["always_same"]
    assert [e["key"] for e in r["recipe"]["errors"]] == ["transpose_instead", "forgot_det"]
    assert len(r["samples"]) == 3
    assert r["stats"]["distinctAnswers"] >= 20


def test_inverse_generates_simple_numbers_and_grades():
    recipe = parse_recipe(INVERSE)
    inst = generate(recipe, random.Random(1))
    assert inst["answerKind"] == "matrix" and inst["shape"] == {"rows": 2, "cols": 2}
    assert "\\left[" in inst["statement"] or "\\begin" in inst["statement"]
    assert grade(inst, {"result": inst["answer"]}) == {"correct": True}
    wrong = inst["errors"]["transpose_instead"]
    assert grade(inst, {"result": wrong}) == {"correct": False, "detectorKey": "transpose_instead"}
    assert grade(inst, {"result": [["1", "2"], ["3", "x+"]]}) == {"correct": False, "detectorKey": "unreadable_answer"}
    assert inst["mcq"]["correct"] == inst["answer"]
    assert inst["mcq"]["distractors"]["transpose_instead"] == wrong


def test_derivative_accepts_equivalent_forms():
    r = validate(DERIVATIVE)
    assert r["ok"], r["problems"]
    inst = generate(parse_recipe(DERIVATIVE), random.Random(3))
    a = int(inst["params"]["a"])
    b = int(inst["params"]["b"])
    assert grade(inst, {"result": f"{b} + {3 * a}*x^2"}) == {"correct": True}
    assert grade(inst, {"result": f"{3 * a}*x^3 + {b}"}) == {"correct": False, "detectorKey": "power_not_lowered"}


def test_impossible_or_malformed_recipe():
    impossible = {**INVERSE, "constraints": ["det(A) == 1000"]}
    r = validate(impossible)
    assert not r["ok"] and "constraints" in r["problems"][0]
    no_variety = {**DERIVATIVE, "params": [{"name": "a", "kind": "int", "min": 2, "max": 2}, {"name": "b", "kind": "int", "min": 1, "max": 1}]}
    assert any("variety" in p for p in validate(no_variety)["problems"])
    assert not validate({**INVERSE, "statement": "Use {B}"})["ok"]
    assert not validate({**INVERSE, "answer": {"kind": "matrix", "expr": "A.inv()"}})["ok"]


def test_endpoints_validate_generate_grade():
    client = TestClient(app)
    v = client.post("/v1/recipes/validate", json={"recipe": INVERSE}).json()
    assert v["ok"]
    g = client.post(
        "/v1/generate",
        json={"evaluatorKey": "recipe_v1", "generationSpec": {"parameters": [], "constraints": [], "recipe": v["recipe"]}, "stepId": "s"},
    ).json()
    payload = g["payload"]
    res = client.post(
        "/v1/grade",
        json={"evaluatorKey": "recipe_v1", "payload": payload, "stepId": "s", "userInput": {"result": payload["answer"]}},
    ).json()
    assert res == {"correct": True, "detectorKey": None}


CLASSIFY = {
    "version": 1,
    "statement": "Classify the system $A x = b$ with $A = [[A]]$ and $b = [[b]]$.",
    "params": [
        {"name": "A", "kind": "matrix", "rows": 2, "cols": 2, "min": -3, "max": 3},
        {"name": "b", "kind": "vector", "size": 2, "min": -3, "max": 3},
    ],
    "answer": {
        "kind": "choice",
        "choices": ["Consistent determinate", "Consistent indeterminate", "Inconsistent"],
        "expr": "cases(rank(A) < rank(augment(A, b)), 2, rank(A) == cols(A), 0, 1)",
    },
}


def test_choice_answer():
    r = validate(CLASSIFY)
    assert r["ok"], r["problems"]
    inst = generate(parse_recipe(CLASSIFY), random.Random(5))
    assert inst["answerKind"] == "choice" and inst["choices"] == CLASSIFY["answer"]["choices"]
    assert grade(inst, {"result": inst["answer"]}) == {"correct": True}
    idx = CLASSIFY["answer"]["choices"].index(inst["answer"])
    assert grade(inst, {"result": idx}) == {"correct": True}
    other = next(c for c in CLASSIFY["answer"]["choices"] if c != inst["answer"])
    assert grade(inst, {"result": other})["correct"] is False
    assert inst["answer"] not in inst["mcq"]["distractors"].values()
    assert len(inst["mcq"]["distractors"]) == 2


def test_choice_without_variety_is_rejected():
    always = {**CLASSIFY, "answer": {**CLASSIFY["answer"], "expr": "0"}}
    assert any("same option" in p for p in validate(always)["problems"])


def test_statement_normalizes_escapes_and_signs():
    rec = {
        **DERIVATIVE,
        "statement": "Find $\\\\mathbb{R}$: $f(x) = [[a]] x^3 + [[b]] x$.",
        "params": [
            {"name": "a", "kind": "int", "min": 1, "max": 1},
            {"name": "b", "kind": "int", "min": -3, "max": -3},
        ],
    }
    inst = generate(parse_recipe(rec), random.Random(0))
    assert inst["statement"] == "Find $\\mathbb{R}$: $f(x) = x^3 - 3 x$."
