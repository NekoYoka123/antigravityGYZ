/**
 * 数组处理工具函数
 * 封装常用的数组处理逻辑，避免重复代码
 */

/**
 * 计算数字数组的中位数
 * @param numbers 数字数组
 * @returns 中位数，或 null（如果数组为空）
 */
export function calculateMedian(numbers: number[]): number | null {
    if (numbers.length === 0) {
        return null;
    }

    const sorted = [...numbers].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    
    return sorted.length % 2 
        ? sorted[mid] 
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 从对象数组中提取数字，过滤掉 null/undefined
 * @param objects 对象数组
 * @param extractor 提取函数，从对象中获取数字
 * @returns 提取出的数字数组
 */
export function extractNumbersFromObjects<T>(
    objects: T[], 
    extractor: (obj: T) => number | null | undefined
): number[] {
    return objects
        .map(extractor)
        .filter((value): value is number => typeof value === 'number' && !isNaN(value));
}

/**
 * 从嵌套对象中提取指定路径的数字
 * @param data 嵌套对象数据
 * @param path 路径字符串，如 'windowSeconds'
 * @returns 提取出的数字数组
 */
export function extractNumbersFromNestedData(
    data: any, 
    path: string
): number[] {
    const result: number[] = [];
    
    // 递归遍历对象
    function traverse(obj: any) {
        if (typeof obj === 'object' && obj !== null) {
            if (Array.isArray(obj)) {
                obj.forEach(item => traverse(item));
            } else {
                // 检查当前对象是否有指定路径
                if (obj[path] !== undefined && obj[path] !== null) {
                    const num = Number(obj[path]);
                    if (!isNaN(num)) {
                        result.push(num);
                    }
                }
                // 继续遍历子对象
                Object.values(obj).forEach(value => traverse(value));
            }
        }
    }
    
    traverse(data);
    return result;
}
