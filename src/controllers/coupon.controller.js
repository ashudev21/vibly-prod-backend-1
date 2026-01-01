import Coupon from "../models/coupon.model.js";
import mongoose from "mongoose";
import logger from "../utils/logger.js";

/* Admin Routes */

/**
 * @route   POST /admin/coupons
 * @desc    Create a new coupon
 * @access  Private (Admin)
 */
export const createCoupon = async (req, res) => {
    try {
        const {
            code,
            description,
            discountType,
            discountValue,
            minPurchaseAmount,
            maxDiscountAmount,
            startDate,
            endDate,
            usageLimit,
            applicableTo,
            categoryIds,
            productIds,
        } = req.body;

        // Check if coupon code already exists
        const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
        if (existingCoupon) {
            return res.status(400).json({ message: "Coupon code already exists" });
        }

        const coupon = await Coupon.create({
            code: code.toUpperCase(),
            description,
            discountType,
            discountValue,
            minPurchaseAmount: minPurchaseAmount || 0,
            maxDiscountAmount,
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            usageLimit: usageLimit || null,
            applicableTo: applicableTo || "all",
            categoryIds: categoryIds || [],
            productIds: productIds || [],
        });

        return res.status(201).json({ data: coupon, message: "Coupon created successfully" });
    } catch (err) {
        logger.error("Error creating coupon:", err);
        return res.status(500).json({ message: "Create failed", error: err.message });
    }
};

/**
 * @route   GET /admin/coupons
 * @desc    Get all coupons
 * @access  Private (Admin)
 */
export const getCouponsForAdmin = async (req, res) => {
    try {
        const { isActive } = req.query;
        let filter = {};

        if (isActive === "true") {
            filter.isActive = true;
        } else if (isActive === "false") {
            filter.isActive = false;
        }

        const coupons = await Coupon.find(filter)
            .populate("categoryIds", "name")
            .populate("productIds", "name")
            .sort({ createdAt: -1 });

        return res.status(200).json({ data: coupons });
    } catch (err) {
        logger.error("Error fetching coupons:", err);
        return res.status(500).json({ message: "Fetch failed", error: err.message });
    }
};

/**
 * @route   GET /admin/coupons/:id
 * @desc    Get coupon by ID
 * @access  Private (Admin)
 */
export const getCouponById = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id)
            .populate("categoryIds", "name")
            .populate("productIds", "name");

        if (!coupon) {
            return res.status(404).json({ message: "Coupon not found" });
        }

        return res.status(200).json({ data: coupon });
    } catch (err) {
        logger.error("Error fetching coupon:", err);
        return res.status(500).json({ message: "Fetch failed", error: err.message });
    }
};

/**
 * @route   PATCH /admin/coupons/:id
 * @desc    Update coupon
 * @access  Private (Admin)
 */
export const updateCoupon = async (req, res) => {
    try {
        const {
            code,
            description,
            discountType,
            discountValue,
            minPurchaseAmount,
            maxDiscountAmount,
            startDate,
            endDate,
            usageLimit,
            applicableTo,
            categoryIds,
            productIds,
            isActive,
        } = req.body;

        const updateData = {};

        if (code !== undefined) updateData.code = code.toUpperCase();
        if (description !== undefined) updateData.description = description;
        if (discountType !== undefined) updateData.discountType = discountType;
        if (discountValue !== undefined) updateData.discountValue = discountValue;
        if (minPurchaseAmount !== undefined) updateData.minPurchaseAmount = minPurchaseAmount;
        if (maxDiscountAmount !== undefined) updateData.maxDiscountAmount = maxDiscountAmount;
        if (startDate !== undefined) updateData.startDate = new Date(startDate);
        if (endDate !== undefined) updateData.endDate = new Date(endDate);
        if (usageLimit !== undefined) updateData.usageLimit = usageLimit || null;
        if (applicableTo !== undefined) updateData.applicableTo = applicableTo;
        if (categoryIds !== undefined) updateData.categoryIds = categoryIds;
        if (productIds !== undefined) updateData.productIds = productIds;
        if (isActive !== undefined) updateData.isActive = isActive;

        // Check if code is being updated and if it already exists
        if (code) {
            const existingCoupon = await Coupon.findOne({
                code: code.toUpperCase(),
                _id: { $ne: req.params.id },
            });
            if (existingCoupon) {
                return res.status(400).json({ message: "Coupon code already exists" });
            }
        }

        const updatedCoupon = await Coupon.findByIdAndUpdate(req.params.id, updateData, {
            new: true,
            runValidators: true,
        })
            .populate("categoryIds", "name")
            .populate("productIds", "name");

        if (!updatedCoupon) {
            return res.status(404).json({ message: "Coupon not found" });
        }

        return res.status(200).json({ data: updatedCoupon, message: "Coupon updated successfully" });
    } catch (err) {
        logger.error("Error updating coupon:", err);
        return res.status(500).json({ message: "Update failed", error: err.message });
    }
};

/**
 * @route   DELETE /admin/coupons/:id
 * @desc    Delete coupon
 * @access  Private (Admin)
 */
export const deleteCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findByIdAndDelete(req.params.id);

        if (!coupon) {
            return res.status(404).json({ message: "Coupon not found" });
        }

        return res.status(200).json({ message: "Coupon deleted successfully" });
    } catch (err) {
        logger.error("Error deleting coupon:", err);
        return res.status(500).json({ message: "Delete failed", error: err.message });
    }
};

/**
 * @route   PUT /admin/coupons/:id/toggle
 * @desc    Toggle coupon status
 * @access  Private (Admin)
 */
export const toggleCouponStatus = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id);

        if (!coupon) {
            return res.status(404).json({ message: "Coupon not found" });
        }

        coupon.isActive = !coupon.isActive;
        await coupon.save();

        return res.status(200).json({
            data: coupon,
            message: `Coupon ${coupon.isActive ? "activated" : "deactivated"}`,
        });
    } catch (err) {
        logger.error("Error toggling coupon status:", err);
        return res.status(500).json({ message: "Toggle failed", error: err.message });
    }
};

/* User Routes */

/**
 * @route   GET /coupons
 * @desc    Get all active coupons
 * @access  Public
 */
export const getActiveCoupons = async (req, res) => {
    try {
        const now = new Date();
        const coupons = await Coupon.find({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            $or: [
                { usageLimit: null },
                { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
            ],
        })
            .select("code description discountType discountValue minPurchaseAmount maxDiscountAmount")
            .sort({ createdAt: -1 });

        return res.status(200).json({ data: coupons });
    } catch (err) {
        logger.error("Error fetching active coupons:", err);
        return res.status(500).json({ message: "Fetch failed", error: err.message });
    }
};

/**
 * @route   GET /coupons/product/:productId
 * @desc    Get active coupons applicable to a specific product
 * @access  Public
 */
export const getCouponsForProduct = async (req, res) => {
    try {
        const { productId } = req.params;
        const { categoryId } = req.query; // Optional category ID from query

        if (!productId) {
            return res.status(400).json({ success: false, message: "Product ID is required" });
        }

        const now = new Date();
        const productObjectId = new mongoose.Types.ObjectId(productId);
        
        // Build applicability filter
        const applicabilityFilter = [
            { applicableTo: "all" },
            { applicableTo: "product", productIds: { $in: [productObjectId] } },
        ];
        
        if (categoryId) {
            const categoryObjectId = new mongoose.Types.ObjectId(categoryId);
            applicabilityFilter.push({
                applicableTo: "category",
                categoryIds: { $in: [categoryObjectId] },
            });
        }
        
        // Find coupons that are:
        // 1. Active
        // 2. Within date range
        // 3. Not exceeded usage limit
        // 4. Applicable to: all products, OR this specific product, OR this product's category
        const coupons = await Coupon.find({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            $and: [
                {
                    $or: [
                        { usageLimit: null },
                        { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
                    ],
                },
                {
                    $or: applicabilityFilter,
                },
            ],
        })
            .select("code description discountType discountValue minPurchaseAmount maxDiscountAmount applicableTo endDate")
            .sort({ createdAt: -1 });

        return res.status(200).json({ success: true, data: coupons });
    } catch (err) {
        logger.error("Error fetching coupons for product:", err);
        return res.status(500).json({ success: false, message: "Fetch failed", error: err.message });
    }
};

/**
 * @route   POST /coupons/validate
 * @desc    Validate and get coupon discount
 * @access  Public
 */
export const validateCoupon = async (req, res) => {
    try {
        const { code, orderAmount, items } = req.body;

        if (!code) {
            return res.status(400).json({ message: "Coupon code is required" });
        }

        if (!orderAmount || orderAmount <= 0) {
            return res.status(400).json({ message: "Valid order amount is required" });
        }

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon) {
            return res.status(404).json({ message: "Invalid coupon code" });
        }

        // Check if coupon is active
        if (!coupon.isActive) {
            return res.status(400).json({ message: "Coupon is not active" });
        }

        // Check date validity
        const now = new Date();
        if (now < coupon.startDate) {
            return res.status(400).json({ message: "Coupon is not yet active" });
        }
        if (now > coupon.endDate) {
            return res.status(400).json({ message: "Coupon has expired" });
        }

        // Check usage limit
        if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
            return res.status(400).json({ 
                message: "Coupon usage limit has been reached" 
            });
        }

        // Check minimum purchase amount
        if (orderAmount < coupon.minPurchaseAmount) {
            return res.status(400).json({
                message: `Minimum purchase amount of ₹${coupon.minPurchaseAmount} required`,
            });
        }

        // Check if coupon is applicable to the order items
        if (coupon.applicableTo !== "all" && items && items.length > 0) {
            if (coupon.applicableTo === "category") {
                const itemCategoryIds = items.map((item) => item.categoryId?.toString()).filter(Boolean);
                const applicableCategories = coupon.categoryIds.map((id) => id.toString());
                const hasApplicableCategory = itemCategoryIds.some((catId) =>
                    applicableCategories.includes(catId)
                );

                if (!hasApplicableCategory) {
                    return res.status(400).json({
                        message: "This coupon is not applicable to items in your cart",
                    });
                }
            } else if (coupon.applicableTo === "product") {
                const itemProductIds = items.map((item) => item.productId?.toString()).filter(Boolean);
                const applicableProducts = coupon.productIds.map((id) => id.toString());
                const hasApplicableProduct = itemProductIds.some((prodId) =>
                    applicableProducts.includes(prodId)
                );

                if (!hasApplicableProduct) {
                    return res.status(400).json({
                        message: "This coupon is not applicable to items in your cart",
                    });
                }
            }
        }

        // Calculate discount
        const discountAmount = coupon.calculateDiscount(orderAmount);

        return res.status(200).json({
            data: {
                coupon: {
                    code: coupon.code,
                    discountType: coupon.discountType,
                    discountValue: coupon.discountValue,
                    discountAmount,
                },
                orderAmount,
                discountAmount,
                finalAmount: orderAmount - discountAmount,
            },
            message: "Coupon applied successfully",
        });
    } catch (err) {
        logger.error("Error validating coupon:", err);
        return res.status(500).json({ message: "Validation failed", error: err.message });
    }
};

/**
 * @route   POST /coupons/:code/apply
 * @desc    Apply coupon and increment usage count
 * @access  Public
 */
export const applyCoupon = async (req, res) => {
    try {
        const { code } = req.params;
        const { orderAmount } = req.body;

        const coupon = await Coupon.findOne({ code: code.toUpperCase() });

        if (!coupon) {
            return res.status(404).json({ message: "Invalid coupon code" });
        }

        if (!coupon.isValid()) {
            return res.status(400).json({ message: "Coupon is not valid or has expired" });
        }

        if (orderAmount < coupon.minPurchaseAmount) {
            return res.status(400).json({
                message: `Minimum purchase amount of ₹${coupon.minPurchaseAmount} required`,
            });
        }

        // Increment usage count
        coupon.usedCount += 1;
        await coupon.save();

        const discountAmount = coupon.calculateDiscount(orderAmount);

        return res.status(200).json({
            data: {
                coupon: {
                    code: coupon.code,
                    discountType: coupon.discountType,
                    discountValue: coupon.discountValue,
                    discountAmount,
                },
                orderAmount,
                discountAmount,
                finalAmount: orderAmount - discountAmount,
            },
            message: "Coupon applied successfully",
        });
    } catch (err) {
        logger.error("Error applying coupon:", err);
        return res.status(500).json({ message: "Apply failed", error: err.message });
    }
};

