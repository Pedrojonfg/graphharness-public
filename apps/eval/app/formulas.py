# Ported from graphlearn/apps/eval/app/formulas.py (65b56d6).
import re
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeout

from sympy import simplify
from sympy.parsing.latex import parse_latex
from sympy.parsing.sympy_parser import (
    convert_xor,
    implicit_multiplication_application,
    parse_expr,
    standard_transformations,
)

_TRANSFORMATIONS = standard_transformations + (
    implicit_multiplication_application,
    convert_xor,
)

_FORBIDDEN_LATEX = re.compile(
    r"\\(?:input|include|write|def|newcommand|immediate)\b",
    re.IGNORECASE,
)

_VERIFY_TIMEOUT_S = 2.0


def _reject_forbidden_latex(*parts: str) -> None:
    for part in parts:
        if _FORBIDDEN_LATEX.search(part):
            raise ValueError("forbidden_latex")


def expressions_equivalent(left: str, right: str) -> bool:
    left_expr = parse_expr(left, transformations=_TRANSFORMATIONS)
    right_expr = parse_expr(right, transformations=_TRANSFORMATIONS)
    return simplify(left_expr - right_expr) == 0


def _latex_equivalent_work(left: str, right: str) -> bool:
    left_expr = parse_latex(left)
    right_expr = parse_latex(right)
    return simplify(left_expr - right_expr) == 0


def latex_expressions_equivalent(left: str, right: str, timeout: float = _VERIFY_TIMEOUT_S) -> bool:
    _reject_forbidden_latex(left, right)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(_latex_equivalent_work, left, right)
        try:
            return future.result(timeout=timeout)
        except FuturesTimeout:
            raise ValueError("verify_timeout")
