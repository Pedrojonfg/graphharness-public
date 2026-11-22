# Ported from graphlearn/apps/eval/tests/test_formulas.py (65b56d6).
from fastapi.testclient import TestClient

from app.formulas import expressions_equivalent, latex_expressions_equivalent
from app.main import app

client = TestClient(app)


def test_equivalent_expressions():
    assert expressions_equivalent("x + 1", "1 + x") is True


def test_non_equivalent():
    assert expressions_equivalent("x + 1", "x + 2") is False


def test_latex_equivalent():
    assert latex_expressions_equivalent("x+1", "1+x") is True


def test_latex_non_equivalent():
    assert latex_expressions_equivalent("x+1", "x+2") is False


def test_latex_forbidden_command_returns_400():
    res = client.post(
        "/v1/formulas/verify",
        json={"latexLeft": r"\input{foo}", "latexRight": "x"},
    )
    assert res.status_code == 400
    assert res.json()["detail"] == "invalid_expression"


def test_verify_sympy_via_http():
    res = client.post("/v1/formulas/verify", json={"left": "x+1", "right": "1+x"})
    assert res.status_code == 200
    assert res.json() == {"equivalent": True}


def test_verify_latex_via_http():
    res = client.post(
        "/v1/formulas/verify",
        json={"latexLeft": "x+1", "latexRight": "1+x"},
    )
    assert res.status_code == 200
    assert res.json() == {"equivalent": True}


def test_verify_rejects_mixed_modes():
    res = client.post(
        "/v1/formulas/verify",
        json={"left": "x", "latexRight": "x"},
    )
    assert res.status_code == 422
