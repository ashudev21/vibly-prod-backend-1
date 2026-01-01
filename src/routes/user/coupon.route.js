import express from "express";
import {
    getActiveCoupons,
    getCouponsForProduct,
    validateCoupon,
    applyCoupon,
} from "../../controllers/coupon.controller.js";

const router = express.Router();

/**
 * @route   GET /
 * @desc    Get all active coupons
 * @access  Public
 */
router.get("/", getActiveCoupons);

/**
 * @route   GET /product/:productId
 * @desc    Get active coupons applicable to a specific product
 * @access  Public
 */
router.get("/product/:productId", getCouponsForProduct);

/**
 * @route   POST /validate
 * @desc    Validate coupon code
 * @access  Public
 */
router.post("/validate", validateCoupon);

/**
 * @route   POST /:code/apply
 * @desc    Apply coupon code
 * @access  Public
 */
router.post("/:code/apply", applyCoupon);

export default router;

