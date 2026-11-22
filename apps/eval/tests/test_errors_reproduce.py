"""Contract of POST /v1/errors/reproduce (promotion of personal errors).

ok = valid expression (allowlist) AND reproducesUser AND distinguishable.
- reproducesUser: evaluated on the given instance, it gives exactly the student's answer (`_same`).
- distinguishable: over `samples` (≥ 5) new instances of the recipe, it gives a value different from the
  correct one and from each error already present in the recipe.
`problems` convention (same as /v1/recipes/validate): empty if ok, non-empty if not.
"""

import random
from functools import cache

import pytest
import sympy
from fastapi.testclient import TestClient

from app.main import app
from app.recipes import evaluate, generate, parse_recipe, serialize, validate

# Real recipes from tests/test_recipes.py.
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

INVERSE = {
    "version": 1,
    "statement": "Compute the inverse of the matrix $A = [[A]]$.",
    "params": [{"name": "A", "kind": "matrix", "rows": 2, "cols": 2, "min": -6, "max": 6}],
    "constraints": ["Abs(det(A)) >= 2", "Abs(det(A)) <= 4"],
    "answer": {"kind": "matrix", "expr": "inv(A)"},
    "errors": [
        {"key": "transpose_instead", "description": "Transposes instead of inverting", "expr": "transpose(A)"},
        {"key": "forgot_det", "description": "Forgets to divide by the determinant", "expr": "det(A) * inv(A)"},
    ],
}

# Sign error: b ≠ 0 and a ≠ 0, so in EVERY instance it differs from the solution (3a·x² + b)
# and from the recipe's error (3a·x³ + b). Distinguishability does not depend on chance.
SIGN_FLIP = {
    "key": "sign_flip_linear",
    "description": "Flips the sign of the linear term when differentiating",
    "expr": "3*a*x^2 - b",
}

client = TestClient(app)


@cache
def _recipe(name):
    """The recipe as the Hub stores it: normalized by /v1/recipes/validate (once per recipe)."""
    v = validate({"derivative": DERIVATIVE, "inverse": INVERSE}[name])
    assert v["ok"], v["problems"]
    return v["recipe"]


def _instance(recipe, seed):
    """Same `payload` that /v1/generate returns, but with a fixed seed."""
    return generate(parse_recipe(recipe), random.Random(seed))


def _derivative_params(payload):
    return int(payload["params"]["a"]), int(payload["params"]["b"])


def _sign_flip_answer(payload):
    """Student answer with the sign changed, written in another equivalent form
    (different term order) so that the comparison has to be symbolic."""
    a, b = _derivative_params(payload)
    return {"result": f"{-b} + {3 * a}*x^2"}


def _reproduce(recipe, payload, user_input, candidate, samples=5):
    return client.post(
        "/v1/errors/reproduce",
        json={
            "recipe": recipe,
            "instancePayload": payload,
            "userInput": user_input,
            "candidate": candidate,
            "samples": samples,
        },
    )


def _ok_body(res):
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"ok", "reproducesUser", "distinguishable", "problems"}
    assert isinstance(body["problems"], list) and all(isinstance(p, str) for p in body["problems"])
    return body


@pytest.mark.parametrize("seed", [1, 3, 7])
def test_sign_error_that_reproduces_the_answer_is_accepted(seed):
    recipe = _recipe("derivative")
    payload = _instance(recipe, seed)
    body = _ok_body(_reproduce(recipe, payload, _sign_flip_answer(payload), SIGN_FLIP))
    assert body == {"ok": True, "reproducesUser": True, "distinguishable": True, "problems": []}


def test_candidate_that_does_not_reproduce_the_student_answer():
    recipe = _recipe("derivative")
    payload = _instance(recipe, 1)
    drops_linear = {"key": "drops_linear", "description": "Forgets to differentiate the linear term", "expr": "3*a*x^2"}
    body = _ok_body(_reproduce(recipe, payload, _sign_flip_answer(payload), drops_linear))
    assert body["reproducesUser"] is False
    assert body["ok"] is False
    assert body["problems"]


def test_candidate_equal_to_the_solution_is_not_distinguishable():
    recipe = _recipe("derivative")
    payload = _instance(recipe, 1)
    # The student "gets it right" and the candidate is the solution written another way: it reproduces, but
    # it is never distinguishable from the correct one.
    same = {"key": "same_as_answer", "description": "It is the correct solution", "expr": "b + 3*a*x^2"}
    body = _ok_body(_reproduce(recipe, payload, {"result": payload["answer"]}, same))
    assert body["reproducesUser"] is True
    assert body["distinguishable"] is False
    assert body["ok"] is False
    assert body["problems"]


def test_candidate_equal_to_a_recipe_error_is_not_distinguishable():
    recipe = _recipe("derivative")
    payload = _instance(recipe, 1)
    # Same expression as power_not_lowered, reordered: it reproduces its value, but adds nothing.
    duplicate = {"key": "power_again", "description": "Does not lower the exponent (again)", "expr": "b + 3*x^3*a"}
    user = {"result": payload["errors"]["power_not_lowered"]}
    body = _ok_body(_reproduce(recipe, payload, user, duplicate))
    assert body["reproducesUser"] is True
    assert body["distinguishable"] is False
    assert body["ok"] is False
    assert body["problems"]


@pytest.mark.parametrize(
    "expr",
    [
        "__import__('os').system('x')",
        "open('x')",
        "().__class__",
        "a.real",
        "3*a*x^2 +",
        "3*c*x^2 - b",
    ],
)
def test_expression_outside_allowlist_is_rejected_without_500(expr):
    recipe = _recipe("derivative")
    payload = _instance(recipe, 1)
    candidate = {"key": "bad_expr", "description": "Expression not allowed", "expr": expr}
    body = _ok_body(_reproduce(recipe, payload, _sign_flip_answer(payload), candidate))
    assert body["ok"] is False
    assert body["reproducesUser"] is False
    assert body["distinguishable"] is False
    assert body["problems"]


def test_matrix_answer_is_compared_on_the_instance():
    """Forgetting the sign in the adjugate of a 2×2: [[d, b], [c, a]] / det instead of [[d, -b], [-c, a]] / det."""
    recipe = _recipe("inverse")
    payload = _instance(recipe, 1)
    A = sympy.Matrix([[sympy.Rational(x) for x in row] for row in payload["params"]["A"]])
    expr = "matrix([entry(A, 1, 1), entry(A, 0, 1)], [entry(A, 1, 0), entry(A, 0, 0)]) / det(A)"
    user = {"result": serialize(evaluate(expr, {"A": A}), "matrix")}
    assert user["result"] != payload["answer"]  # the instance is not diagonal: it is a real failure
    candidate = {"key": "adjugate_no_sign", "description": "Forgets to change the sign in the adjugate", "expr": expr}
    body = _ok_body(_reproduce(recipe, payload, user, candidate))
    # Distinguishability here depends on chance (diagonal matrices); only the reproduction is checked.
    assert body["reproducesUser"] is True
    other = {**candidate, "expr": "transpose(A) / det(A)"}
    assert _ok_body(_reproduce(recipe, payload, user, other))["reproducesUser"] is False


@pytest.mark.parametrize("samples", [5, 12])
def test_valid_samples_respond_without_hanging(samples):
    recipe = _recipe("derivative")
    payload = _instance(recipe, 3)
    body = _ok_body(_reproduce(recipe, payload, _sign_flip_answer(payload), SIGN_FLIP, samples=samples))
    assert body["ok"] is True


@pytest.mark.parametrize("samples", [0, 4, -1])
def test_samples_below_5_is_422(samples):
    """The spec asks for ≥ 5 new instances: it is rejected at the boundary (422) instead of being
    silently corrected, so that the caller does not believe it asked for fewer and was checked less."""
    recipe = _recipe("derivative")
    payload = _instance(recipe, 3)
    res = _reproduce(recipe, payload, _sign_flip_answer(payload), SIGN_FLIP, samples=samples)
    assert res.status_code == 422
