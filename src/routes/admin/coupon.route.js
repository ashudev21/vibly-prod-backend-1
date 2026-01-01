import express from "express";
import {
    createCoupon,
    deleteCoupon,
    getCouponsForAdmin,
    getCouponById,
    toggleCouponStatus,
    updateCoupon,
} from "../../controllers/coupon.controller.js";

const router = express.Router();

/**
 * @route   GET /
 * @desc    Get all coupons
 * @access  Private (Admin)
 */
router.get("/", getCouponsForAdmin);

/**
 * @route   GET /:id
 * @desc    Get coupon by ID
 * @access  Private (Admin)
 */
router.get("/:id", getCouponById);

/**
 * @route   POST /
 * @desc    Create a new coupon
 * @access  Private (Admin)
 */
router.post("/", createCoupon);

/**
 * @route   PATCH /:id
 * @desc    Update a coupon
 * @access  Private (Admin)
 */
router.patch("/:id", updateCoupon);

/**
 * @route   DELETE /:id
 * @desc    Delete a coupon
 * @access  Private (Admin)
 */
router.delete("/:id", deleteCoupon);

/**
 * @route   PUT /:id/toggle
 * @desc    Toggle a coupon's status
 * @access  Private (Admin)
 */
router.put("/:id/toggle", toggleCouponStatus);

export default router;

