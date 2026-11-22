# Ported from graphlearn/apps/eval/app/registry.py (65b56d6).
from app.evaluators.code_comprehension_v1 import CODE_COMPREHENSION_EVALUATOR_KEY, CodeComprehensionEvaluator
from app.evaluators.matrix_multiply_2x2 import MatrixMultiply2x2Full
from app.recipes import RECIPE_EVALUATOR_KEY, RecipeEvaluator

EVALUATORS: dict[str, object] = {
    "matrix_multiply_2x2_full": MatrixMultiply2x2Full(),
    # 039.4: templates whose recipe was written by the AI and validated by this service.
    RECIPE_EVALUATOR_KEY: RecipeEvaluator(),
    # ADR 108: Parsons / predict / spot_bug (without running code).
    CODE_COMPREHENSION_EVALUATOR_KEY: CodeComprehensionEvaluator(),
}
