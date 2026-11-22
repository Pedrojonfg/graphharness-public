# Ported from graphlearn/apps/eval/tests/test_matrix_multiply.py (65b56d6).
from app.evaluators.matrix_multiply_2x2 import MatrixMultiply2x2Full

CASE = {
    "parameters": [],
    "constraints": [{"kind": "integer_entries", "min": -9, "max": 9}],
    "simplicityPolicy": {"maxAttempts": 8},
}


def test_generate_and_grade_correct():
    ev = MatrixMultiply2x2Full()
    payload = ev.generate(CASE)
    grade = ev.grade(payload, {"result": payload["C"]})
    assert grade["correct"] is True


def test_generate_includes_mcq():
    ev = MatrixMultiply2x2Full()
    payload = ev.generate(CASE)
    mcq = payload["mcq"]
    assert mcq["correct"] == payload["C"]
    assert "row_column_swap" in mcq["distractors"]
    from sympy import Matrix

    swapped = (Matrix(payload["B"]) * Matrix(payload["A"])).tolist()
    assert mcq["distractors"]["row_column_swap"] == [[int(c) for c in row] for row in swapped]
    assert "mcq" in payload
    assert payload["mcq"]["correct"] == payload["C"]
    assert "row_column_swap" in payload["mcq"]["distractors"]


def test_dimension_mismatch():
    ev = MatrixMultiply2x2Full()
    payload = ev.generate(CASE)
    grade = ev.grade(payload, {"result": [[1, 2, 3], [4, 5, 6]]})
    assert grade["correct"] is False
    assert grade.get("detectorKey") == "dimension_mismatch"


def test_row_column_swap():
    ev = MatrixMultiply2x2Full()
    a = [[1, 2], [0, 1]]
    b = [[3, 0], [1, 2]]
    from sympy import Matrix

    c = (Matrix(a) * Matrix(b)).tolist()
    payload = {"A": a, "B": b, "C": c}
    swapped = (Matrix(b) * Matrix(a)).tolist()
    grade = ev.grade(payload, {"result": swapped})
    assert grade["correct"] is False
    assert grade.get("detectorKey") == "row_column_swap"
