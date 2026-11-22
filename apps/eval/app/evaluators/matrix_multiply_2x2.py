# Ported from graphlearn/apps/eval/app/evaluators/matrix_multiply_2x2.py (65b56d6).
import random
from typing import Any

from sympy import Matrix


def _is_2x2_int_matrix(value: Any) -> bool:
    if not isinstance(value, list) or len(value) != 2:
        return False
    for row in value:
        if not isinstance(row, list) or len(row) != 2:
            return False
        for cell in row:
            try:
                int(cell)
            except (TypeError, ValueError):
                return False
    return True


def _as_int_matrix(value: list[list[Any]]) -> list[list[int]]:
    return [[int(cell) for cell in row] for row in value]


class MatrixMultiply2x2Full:
    engine = "sympy_matrix"

    def generate(self, generation_spec: dict[str, Any]) -> dict[str, Any]:
        policy = generation_spec.get("simplicityPolicy") or {}
        max_attempts = int(policy.get("maxAttempts") or 32)
        min_v, max_v = -9, 9
        for constraint in generation_spec.get("constraints") or []:
            if constraint.get("kind") == "integer_entries":
                min_v = int(constraint.get("min", min_v))
                max_v = int(constraint.get("max", max_v))

        for _ in range(max_attempts):
            a = [[random.randint(min_v, max_v) for _ in range(2)] for _ in range(2)]
            b = [[random.randint(min_v, max_v) for _ in range(2)] for _ in range(2)]
            c = (Matrix(a) * Matrix(b)).tolist()
            c_int = _as_int_matrix(c)
            swapped = (Matrix(b) * Matrix(a)).tolist()
            return {
                "A": a,
                "B": b,
                "C": c_int,
                "mcq": {
                    "correct": c_int,
                    "distractors": {"row_column_swap": _as_int_matrix(swapped)},
                },
            }

        # fixed fallback if the loop does not apply (it always should)
        a = [[1, 0], [0, 1]]
        b = [[2, 1], [0, 3]]
        c = (Matrix(a) * Matrix(b)).tolist()
        c_int = _as_int_matrix(c)
        swapped = (Matrix(b) * Matrix(a)).tolist()
        return {
            "A": a,
            "B": b,
            "C": c_int,
            "mcq": {
                "correct": c_int,
                "distractors": {"row_column_swap": _as_int_matrix(swapped)},
            },
        }

    def grade(self, payload: dict[str, Any], user_input: dict[str, Any]) -> dict[str, Any]:
        result = user_input.get("result")
        if not _is_2x2_int_matrix(result):
            return {"correct": False, "detectorKey": "dimension_mismatch"}

        expected = payload.get("C")
        if not _is_2x2_int_matrix(expected):
            raise ValueError("invalid_instance_payload")

        got = _as_int_matrix(result)
        exp = _as_int_matrix(expected)
        if got == exp:
            return {"correct": True}

        a = payload.get("A")
        b = payload.get("B")
        if _is_2x2_int_matrix(a) and _is_2x2_int_matrix(b):
            swapped = (Matrix(b) * Matrix(a)).tolist()
            if got == _as_int_matrix(swapped):
                return {"correct": False, "detectorKey": "row_column_swap"}

        return {"correct": False}
