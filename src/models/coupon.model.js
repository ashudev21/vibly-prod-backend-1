import mongoose from "mongoose";

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: [true, "Coupon code is required"],
            unique: true,
            uppercase: true,
            trim: true,
            index: true,
        },
        description: {
            type: String,
            trim: true,
        },
        discountType: {
            type: String,
            enum: ["percentage", "fixed"],
            required: [true, "Discount type is required"],
        },
        discountValue: {
            type: Number,
            required: [true, "Discount value is required"],
            min: [0, "Discount value cannot be negative"],
        },
        minPurchaseAmount: {
            type: Number,
            default: 0,
            min: [0, "Minimum purchase amount cannot be negative"],
        },
        maxDiscountAmount: {
            type: Number,
            min: [0, "Max discount amount cannot be negative"],
        },
        startDate: {
            type: Date,
            required: [true, "Start date is required"],
        },
        endDate: {
            type: Date,
            required: [true, "End date is required"],
        },
        usageLimit: {
            type: Number,
            default: null, // null means unlimited
            min: [1, "Usage limit must be at least 1"],
        },
        usedCount: {
            type: Number,
            default: 0,
            min: [0, "Used count cannot be negative"],
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        applicableTo: {
            type: String,
            enum: ["all", "category", "product"],
            default: "all",
        },
        categoryIds: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Category",
            },
        ],
        productIds: [
            {
                type: mongoose.Schema.Types.ObjectId,
                ref: "Product",
            },
        ],
    },
    { timestamps: true }
);

// Validate that endDate is after startDate
couponSchema.pre("validate", function (next) {
    if (this.endDate && this.startDate && this.endDate < this.startDate) {
        return next(new Error("End date must be after start date"));
    }
    
    // Validate discount value based on type
    if (this.discountType === "percentage" && this.discountValue > 100) {
        return next(new Error("Percentage discount cannot exceed 100%"));
    }
    
    next();
});

// Method to check if coupon is valid
couponSchema.methods.isValid = function () {
    const now = new Date();
    return (
        this.isActive &&
        now >= this.startDate &&
        now <= this.endDate &&
        (this.usageLimit === null || this.usedCount < this.usageLimit)
    );
};

// Method to calculate discount amount
couponSchema.methods.calculateDiscount = function (orderAmount) {
    if (!this.isValid()) {
        return 0;
    }
    
    if (orderAmount < this.minPurchaseAmount) {
        return 0;
    }
    
    let discount = 0;
    
    if (this.discountType === "percentage") {
        discount = (orderAmount * this.discountValue) / 100;
    } else {
        discount = this.discountValue;
    }
    
    // Apply max discount limit if set
    if (this.maxDiscountAmount && discount > this.maxDiscountAmount) {
        discount = this.maxDiscountAmount;
    }
    
    // Ensure discount doesn't exceed order amount
    return Math.min(discount, orderAmount);
};

const Coupon = mongoose.model("Coupon", couponSchema);
export default Coupon;

